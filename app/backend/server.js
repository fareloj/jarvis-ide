const http = require('node:http');
const crypto = require('node:crypto');
const { EVENT_TYPES, createRunEvent } = require('./protocol');
const rag = require('./rag-client');
const { listCorpusDocuments, saveNote, stageProject } = require('./workspace-indexer');
const { formatMemoriesForPrompt, listMemories, saveMemory } = require('./memory-store');
const { formatSkillsForPrompt, listSkills, loadActiveSkills } = require('./skill-loader');
const tools = require('./tool-registry');
const quota = require('./quota-monitor');
const conversationMemory = require('./conversation-memory');
const gitWorkspace = require('./git-workspace');
const modelCatalog = require('./model-catalog');
const { createSkillReview } = require('./skill-review');
const searchEngine = require('./search-engine');
const { defaultProblemsRunner } = require('./problems-runner');
const {
  DEFAULT_BUDGET,
  compactConversation,
  defaultCheckpointStore,
  defaultJobQueue,
  safeRetry,
  assertRunId,
} = require('./agent-runtime');

const DEFAULT_MODEL = process.env.JARVIS_OLLAMA_MODEL || 'gpt-oss:120b-cloud';
const SKILL_REVIEW_MODEL = process.env.JARVIS_SKILL_REVIEW_MODEL || '';
const OLLAMA_HOST = (process.env.JARVIS_OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Headers': 'content-type',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`A requisição excede o limite de ${Math.round(maxBytes / 1_000_000)} MB.`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function ollamaHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.OLLAMA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
  }
  return headers;
}

function normalizeMessages(messages) {
  const all = Array.isArray(messages)
    ? messages
        .filter((message) => message && ['system', 'user', 'assistant'].includes(message.role))
        .map((message) => {
          const normalized = { role: message.role, content: String(message.content || '').slice(0, 80_000) };
          // `images`: array de strings base64 (sem prefixo data:) pro Ollama
          // decodificar em modelos com visão. Passa direto sem reprocessar —
          // quem valida tamanho/formato é a leitura do anexo no Electron.
          if (Array.isArray(message.images) && message.images.length) {
            normalized.images = message.images.filter((img) => typeof img === 'string').slice(0, 4);
          }
          return normalized;
        })
    : [];
  const system = all.filter((message) => message.role === 'system').slice(0, 6);
  const conversation = all.filter((message) => message.role !== 'system').slice(-40);
  const normalized = [...system, ...conversation];

  if (!normalized.some((message) => message.role === 'user')) {
    throw new Error('Envie ao menos uma mensagem do usuário.');
  }
  return normalized;
}

async function checkOllama() {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      headers: ollamaHeaders(),
      signal: AbortSignal.timeout(3500),
    });
    return {
      online: response.ok,
      latencyMs: Date.now() - startedAt,
      provider: OLLAMA_HOST.includes('ollama.com') ? 'Ollama Cloud' : 'Ollama local',
      model: DEFAULT_MODEL,
    };
  } catch {
    return {
      online: false,
      latencyMs: null,
      provider: OLLAMA_HOST.includes('ollama.com') ? 'Ollama Cloud' : 'Ollama local',
      model: DEFAULT_MODEL,
    };
  }
}

async function chat(messages, model = DEFAULT_MODEL, options = {}) {
  const normalized = normalizeMessages(messages);

  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: ollamaHeaders(),
    body: JSON.stringify({ model, messages: normalized, stream: false }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)])
      : AbortSignal.timeout(180_000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error || `Ollama respondeu com HTTP ${response.status}.`;
    throw new Error(detail);
  }

  return {
    message: payload.message?.content || '',
    model: payload.model || model,
    done: payload.done !== false,
    totalDuration: payload.total_duration || null,
  };
}

const skillReview = createSkillReview({
  reviewModel: SKILL_REVIEW_MODEL,
  generate: async (messages, model, options) => (await chat(messages, model || DEFAULT_MODEL, options)).message,
});

async function streamChat(messages, model, runId, clientResponse, abortController, options = {}) {
  skillReview.cancelReview(options.sessionId);
  const maxTurns = Math.min(Math.max(Number(options.maxTurns) || DEFAULT_BUDGET.maxTurns, 1), 50);
  const maxContextChars = Math.min(Math.max(Number(options.maxContextChars) || DEFAULT_BUDGET.maxContextChars, 4_000), 500_000);
  const maxDurationMs = Math.min(Math.max(Number(options.maxDurationMs) || DEFAULT_BUDGET.maxDurationMs, 10_000), 30 * 60_000);
  const deadline = Date.now() + maxDurationMs;
  const runSignal = AbortSignal.any([abortController.signal, AbortSignal.timeout(maxDurationMs)]);

  defaultJobQueue.createJob({
    runId,
    type: 'agent_chat',
    projectPath: options.projectPath,
    metadata: { model, sessionId: options.sessionId, sessionTitle: options.sessionTitle },
    abortController,
  });

  let conversation = normalizeMessages(messages);
  const skillStates = await skillReview.listSkillStates();
  const activeSkills = (await loadActiveSkills(options.activeSkills))
    .filter((skill) => skillStates[skill.id]?.state !== 'archived');
  skillReview.recordUsage({ skillIds: activeSkills.map((skill) => skill.id), event: 'loaded' }).catch((error) => {
    console.error('[skills] falha ao registrar uso:', error.message);
  });
  const skillPrompt = formatSkillsForPrompt(activeSkills);
  const memories = options.projectPath && !options.memoryContextIncluded ? await listMemories(options.projectPath) : [];
  const memoryPrompt = formatMemoriesForPrompt(memories);
  const memoryContextAvailable = options.memoryContextIncluded || memories.length > 0;

  // Memória semântica entre chats: recupera o que foi dito em OUTRAS sessões
  // e que se parece com a mensagem atual. Nunca deve derrubar a conversa —
  // se o serviço de embedding estiver fora, segue sem recall.
  const lastUserMessage = [...conversation].reverse().find((message) => message.role === 'user')?.content || '';
  // Interruptor vindo das Configuracoes: desligado, o agente nao le nem
  // grava memoria de conversa (a memoria explicita por tool segue valendo).
  const memoriaLigada = options.conversationMemoryEnabled !== false;
  let recallPrompt = '';
  try {
    if (!memoriaLigada) throw new Error('memoria de conversa desligada pelo usuario');
    const recalled = await conversationMemory.recallRelevant({
      projectPath: options.projectPath,
      sessionId: options.sessionId,
      query: lastUserMessage,
    });
    recallPrompt = conversationMemory.formatRecallForPrompt(recalled);
  } catch (error) {
    if (memoriaLigada) console.error('[memória] falha ao recuperar conversas anteriores:', error.message);
  }

  if (skillPrompt) conversation.unshift({ role: 'system', content: skillPrompt });
  if (memoryPrompt) conversation.unshift({ role: 'system', content: `Memória persistente do projeto:\n${memoryPrompt}` });
  if (recallPrompt) conversation.unshift({ role: 'system', content: recallPrompt });
  clientResponse.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });

  let doneSent = false;
  let runFailed = false;
  let awaitingApproval = false;
  let finalAssistantContent = '';
  const runMetrics = { toolCalls: 0, toolResults: 0, toolFailures: 0, turnsUsed: 0 };
  const emit = (type, payload) => {
    const event = createRunEvent(runId, type, payload);
    defaultJobQueue.appendEvent(runId, event);
    clientResponse.write(`${JSON.stringify(event)}\n`);
  };

  for (let turn = 0; turn < maxTurns && !doneSent; turn += 1) {
    if (Date.now() >= deadline) {
      emit(EVENT_TYPES.RUN_FAILED, { error: `O agente excedeu o limite de tempo de ${maxDurationMs} ms.` });
      runFailed = true;
      doneSent = true;
      break;
    }
    runMetrics.turnsUsed = turn + 1;
    conversation = compactConversation(conversation, { maxChars: maxContextChars });

    const upstream = await safeRetry(async () => {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: ollamaHeaders(),
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          messages: conversation,
          stream: true,
          // Se a memória explícita já veio no prompt, memory_list só faria o
          // modelo reler os mesmos dados e atrasaria a resposta com uma tool.
          tools: options.toolsEnabled === false
            ? undefined
            : tools.publicDefinitions({ exclude: memoryContextAvailable ? ['memory_list'] : [] }),
        }),
        signal: AbortSignal.any([runSignal, AbortSignal.timeout(Math.min(180_000, Math.max(1, deadline - Date.now())))]),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const err = new Error(payload.error || `Ollama respondeu com HTTP ${res.status}.`);
        err.status = res.status;
        throw err;
      }
      return res;
    }, { maxRetries: 2, initialDelayMs: 250, signal: runSignal });

    const decoder = new TextDecoder();
    let pending = '';
    let assistantContent = '';
    const toolCalls = [];
    const relay = (line) => {
      if (!line.trim()) return;
      const payload = JSON.parse(line);
      const content = payload.message?.content || '';
      assistantContent += content;
      if (content) emit(EVENT_TYPES.MESSAGE_DELTA, { content, model: payload.model || model });
      if (Array.isArray(payload.message?.tool_calls)) toolCalls.push(...payload.message.tool_calls);
    };
    for await (const chunk of upstream.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) relay(line);
    }
    relay(pending + decoder.decode());

    if (!toolCalls.length) {
      doneSent = true;
      finalAssistantContent = assistantContent;
      emit(EVENT_TYPES.MESSAGE_DONE, { model: model || DEFAULT_MODEL, evidence: runMetrics });
      break;
    }

    runMetrics.toolCalls += toolCalls.length;
    conversation.push({ role: 'assistant', content: assistantContent, tool_calls: toolCalls });

    let approvalRequired = false;
    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') args = JSON.parse(args || '{}');
      emit(EVENT_TYPES.TOOL_REQUESTED, { name, args });

      // Uma tool já concluída nunca é repetida após retomada, inclusive mutações.
      const cachedExecution = await defaultCheckpointStore.hasExecutedTool(runId, name, args);
      if (cachedExecution) {
        runMetrics.toolResults += 1;
        const result = JSON.stringify(cachedExecution.result).slice(0, 120_000);
        emit(EVENT_TYPES.TOOL_RESULT, { name, result: cachedExecution.result, fromCheckpoint: true });
        conversation.push({ role: 'tool', tool_name: name, content: result });
        continue;
      }

      const outcome = await tools.requestTool(name, args, {
        projectPath: options.projectPath,
        corpus: options.corpus,
        signal: runSignal,
        runId,
      });

      if (outcome.status === 'approval_required') {
        approvalRequired = true;
        awaitingApproval = true;
        emit(EVENT_TYPES.APPROVAL_REQUIRED, outcome.approval);
        continue;
      }

      runMetrics.toolResults += 1;
      await defaultCheckpointStore.recordExecutedTool(runId, name, args, outcome.result).catch(() => {});

      const result = JSON.stringify(outcome.result).slice(0, 120_000);
      emit(EVENT_TYPES.TOOL_RESULT, { name, result: outcome.result });
      conversation.push({ role: 'tool', tool_name: name, content: result });
    }

    await defaultCheckpointStore.saveCheckpoint(runId, {
      sessionId: options.sessionId,
      projectPath: options.projectPath,
      turns: turn + 1,
      metrics: runMetrics,
      history: conversation,
    }).catch(() => {});

    if (approvalRequired) {
      doneSent = true;
      emit(EVENT_TYPES.MESSAGE_DONE, {
        model: model || DEFAULT_MODEL,
        awaitingApproval: true,
        evidence: { ...runMetrics, awaitingApproval: true },
      });
    }
  }

  let finalStatus;
  if (!doneSent) {
    emit(EVENT_TYPES.RUN_FAILED, { error: `O agente excedeu o limite configurado de ${maxTurns} rodadas.` });
    finalStatus = 'failed';
  } else if (runFailed) {
    finalStatus = 'failed';
  } else if (awaitingApproval) {
    finalStatus = 'awaiting_approval';
  } else {
    finalStatus = 'completed';
  }
  defaultJobQueue.completeJob(runId, finalStatus);
  await defaultCheckpointStore.saveCheckpoint(runId, {
    status: finalStatus,
    metrics: runMetrics,
    completedAt: new Date().toISOString(),
  }).catch(() => {});

  // Grava o turno na memória semântica depois de responder, para que outras
  // conversas possam recuperá-lo. Falha aqui não afeta a resposta já entregue.
  try {
    if (memoriaLigada) await conversationMemory.rememberTurns({
      projectPath: options.projectPath,
      sessionId: options.sessionId,
      sessionTitle: options.sessionTitle,
      turns: [
        { role: 'user', content: lastUserMessage },
        { role: 'assistant', content: finalAssistantContent },
      ],
    });
  } catch (error) {
    console.error('[memória] falha ao gravar a conversa:', error.message);
  }

  clientResponse.end();
}

// O backend escuta em localhost numa porta efemera. Sem autenticacao,
// qualquer processo local que descubra a porta chama as rotas privadas —
// ler arquivos do projeto, gravar memoria, disparar tools. O token e'
// gerado a cada inicializacao e entregue somente ao processo principal do
// Electron; o renderer nunca o recebe.
const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS']);
const PUBLIC_ROUTES = new Set(['/health']);

function extractBearer(request) {
  const header = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

// Comparacao em tempo constante: comparar com === vazaria o tamanho do
// prefixo correto para quem medisse o tempo de resposta.
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Uma pagina web mal-intencionada mandaria a sua propria origem. O renderer
// carrega via file://, que envia "null", e o processo principal nao envia
// Origin nenhuma.
function originAllowed(request) {
  const origin = request.headers.origin;
  return origin === undefined || origin === 'null';
}

function startBackend({ host = process.env.JARVIS_BACKEND_HOST || '127.0.0.1', port = 0 } = {}) {
  const authToken = crypto.randomBytes(32).toString('hex');

  const server = http.createServer(async (request, response) => {
    let runId = null;

    if (!ALLOWED_METHODS.has(request.method)) {
      sendJson(response, 405, { error: 'Método não permitido.' });
      return;
    }
    if (!originAllowed(request)) {
      sendJson(response, 403, { error: 'Origem não autorizada.' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': 'null',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      response.end();
      return;
    }

    const rota = String(request.url || '').split('?')[0];
    if (!PUBLIC_ROUTES.has(rota) && !tokenMatches(extractBearer(request), authToken)) {
      sendJson(response, 401, { error: 'Requisição não autenticada.' });
      return;
    }

    try {
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, { ok: true, ollama: await checkOllama() });
        return;
      }

      if (request.method === 'GET' && request.url === '/api/rag/health') {
        sendJson(response, 200, await rag.health());
        return;
      }

      if (request.method === 'GET' && request.url === '/api/skills') {
        const states = await skillReview.listSkillStates();
        sendJson(response, 200, {
          skills: (await listSkills()).map(({ content, ...skill }) => ({ ...skill, lifecycle: states[skill.id] || null })),
        });
        return;
      }

      if (request.method === 'GET' && request.url === '/api/skills/reviews') {
        sendJson(response, 200, { proposals: await skillReview.listProposals() });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/skills/review') {
        const body = await readJson(request, 5_000_000);
        sendJson(response, 200, await skillReview.review(body));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/skills/reviews/resolve') {
        const body = await readJson(request);
        sendJson(response, 200, await skillReview.resolve(body.id, body.approved === true));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/skills/curate') {
        const body = await readJson(request);
        sendJson(response, 200, await skillReview.curate({ apply: body.apply === true }));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/skills/policy') {
        const body = await readJson(request);
        sendJson(response, 200, {
          lifecycle: await skillReview.setSkillPolicy(body.skillId, {
            pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
            adopt: body.adopt === true,
            state: body.state,
          }),
        });
        return;
      }

      if (request.method === 'GET' && request.url === '/api/tools') {
        sendJson(response, 200, { tools: tools.describeTools() });
        return;
      }

      if (request.method === 'GET' && request.url === '/api/ollama/quota') {
        sendJson(response, 200, await quota.getQuotaStatus());
        return;
      }

      if (request.method === 'POST' && request.url === '/api/ollama/quota/sync') {
        const body = await readJson(request).catch(() => ({}));
        if (body.cookie) quota.setSessionCookie(body.cookie);
        sendJson(response, 200, await quota.getQuotaStatus(true));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/ollama/quota/config') {
        const body = await readJson(request);
        quota.setSessionCookie(body.cookie);
        sendJson(response, 200, await quota.getQuotaStatus(true));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/memory/conversation/forget') {
        const body = await readJson(request);
        sendJson(response, 200, await conversationMemory.forgetSession(body.sessionId));
        return;
      }

      if (request.method === 'GET' && request.url === '/api/models') {
        sendJson(response, 200, await modelCatalog.listCloudModels());
        return;
      }

      if (request.method === 'POST' && request.url === '/api/tools/approval') {
        const body = await readJson(request);
        const outcome = await tools.resolveApproval(body.id, body.approved === true);
        const runtime = outcome._runtime;
        delete outcome._runtime;
        if (runtime?.runId) {
          if (outcome.status === 'completed') {
            await defaultCheckpointStore.recordExecutedTool(runtime.runId, outcome.name, runtime.args, outcome.result);
          }
          const status = outcome.status === 'completed' ? 'completed'
            : outcome.status === 'background' ? 'background_running' : 'denied';
          await defaultCheckpointStore.saveCheckpoint(runtime.runId, {
            status: outcome.status === 'completed' ? 'completed_after_approval'
              : outcome.status === 'background' ? 'background_running' : 'approval_denied',
            approvalResolvedAt: new Date().toISOString(),
            ...(outcome.job?.id ? { backgroundJobId: outcome.job.id } : {}),
          });
          defaultJobQueue.completeJob(runtime.runId, status);
        }
        sendJson(response, 200, outcome);
        return;
      }

      const terminalJobMatch = /^\/api\/tools\/terminal-jobs\/([^/]+)$/.exec(request.url || '');
      if (terminalJobMatch && request.method === 'GET') {
        const job = tools.getTerminalJob(decodeURIComponent(terminalJobMatch[1]));
        sendJson(response, job ? 200 : 404, job || { error: 'Job de terminal não encontrado ou expirado.' });
        return;
      }
      if (terminalJobMatch && request.method === 'POST') {
        const cancelled = await tools.cancelTerminalJob(decodeURIComponent(terminalJobMatch[1]));
        sendJson(response, cancelled ? 200 : 404, { cancelled });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/memory/list') {
        const body = await readJson(request);
        sendJson(response, 200, { memories: await listMemories(body.projectPath) });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/memory') {
        const body = await readJson(request);
        const saved = await saveMemory(body);
        sendJson(response, 200, saved);
        return;
      }

      if (request.method === 'POST' && request.url === '/api/rag/stage') {
        const body = await readJson(request);
        sendJson(response, 200, await stageProject(body.projectPath));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/rag/index') {
        const body = await readJson(request);
        const staged = body.projectPath
          ? await stageProject(body.projectPath)
          : { corpus: body.corpus, containerPath: `/jarvis-workspace/${body.corpus}` };
        const indexed = await rag.indexCorpus(staged);
        sendJson(response, 200, { staged, indexed });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/rag/search') {
        const body = await readJson(request);
        sendJson(response, 200, await rag.search(body));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/rag/documents') {
        const body = await readJson(request);
        sendJson(response, 200, await listCorpusDocuments(body));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/project/files') {
        const body = await readJson(request);
        sendJson(response, 200, await tools.runTool('project_list_files', { path: body.path }, {
          projectPath: body.projectPath,
        }));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/project/file') {
        const body = await readJson(request);
        sendJson(response, 200, await tools.runTool('project_read_file', { path: body.path }, {
          projectPath: body.projectPath,
        }));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/project/tree') {
        const body = await readJson(request);
        sendJson(response, 200, await tools.listProjectDirectory(body.projectPath, body.path));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/project/preview') {
        const body = await readJson(request);
        sendJson(response, 200, await tools.previewProjectFile(body.projectPath, body.path));
        return;
      }

      // Git: leitura livre; stage, unstage e commit existem porque a interface
      // os chama por acao explicita do usuario. Nenhuma destas rotas vira tool
      // do agente, e nenhuma delas faz push.
      if (request.method === 'POST' && request.url === '/api/git/status') {
        const body = await readJson(request);
        try {
          sendJson(response, 200, await gitWorkspace.status(body.projectPath));
        } catch (error) {
          // Falta de repositorio ou de Git e' um estado da interface, nao uma
          // falha do backend: a aba precisa explicar o que fazer.
          if (error?.code === 'GIT_INDISPONIVEL') {
            sendJson(response, 200, { repositorio: false, motivo: error.message });
            return;
          }
          throw error;
        }
        return;
      }

      if (request.method === 'POST' && request.url === '/api/git/diff') {
        const body = await readJson(request);
        sendJson(response, 200, await gitWorkspace.diff(body.projectPath, {
          path: body.path, staged: body.staged === true, untracked: body.untracked === true,
        }));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/git/stage') {
        const body = await readJson(request);
        sendJson(response, 200, await gitWorkspace.stage(body.projectPath, body.paths));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/git/unstage') {
        const body = await readJson(request);
        sendJson(response, 200, await gitWorkspace.unstage(body.projectPath, body.paths));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/git/commit-scope') {
        const body = await readJson(request);
        sendJson(response, 200, await gitWorkspace.escopoDoCommit(body.projectPath));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/git/commit') {
        const body = await readJson(request);
        sendJson(response, 200, await gitWorkspace.commit(body.projectPath, body.message));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/project/save') {
        const body = await readJson(request, 5_000_000);
        try {
          sendJson(response, 200, await tools.saveProjectFile(body));
        } catch (error) {
          // Conflito nao e' falha do backend: o arquivo mudou no disco depois
          // que o editor o abriu. O 409 deixa a interface oferecer recarregar
          // ou sobrescrever em vez de mostrar um erro generico.
          if (error?.code === 'CONFLITO' || error?.code === 'CAMINHO_ALTERADO') {
            sendJson(response, 409, { error: error.message, code: error.code, hashAtual: error.hashAtual ?? null });
            return;
          }
          throw error;
        }
        return;
      }

      if (request.method === 'POST' && request.url === '/api/project/stat') {
        const body = await readJson(request);
        sendJson(response, 200, await tools.statProjectFile(body.projectPath, body.path));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/search') {
        const body = await readJson(request);
        const controller = new AbortController();
        request.once('aborted', () => controller.abort());
        response.once('close', () => {
          if (!response.writableEnded) controller.abort();
        });
        sendJson(response, 200, await searchEngine.searchProjectText(body, { signal: controller.signal }));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/search/plan-replace') {
        const body = await readJson(request);
        sendJson(response, 200, await searchEngine.planSearchReplace(body));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/search/apply-replace') {
        const body = await readJson(request);
        sendJson(response, 200, await searchEngine.applySearchReplace(body));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/problems/run') {
        const body = await readJson(request);
        sendJson(response, 200, await defaultProblemsRunner.runDiagnostics(body));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/problems/cancel') {
        const body = await readJson(request);
        sendJson(response, 200, { cancelled: await defaultProblemsRunner.cancelRun(body.runId) });
        return;
      }

      if (request.method === 'GET' && request.url === '/api/agent/jobs') {
        sendJson(response, 200, { jobs: defaultJobQueue.listJobs() });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/agent/jobs/cancel') {
        const body = await readJson(request);
        sendJson(response, 200, { cancelled: await defaultJobQueue.cancelJob(body.runId) });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/agent/checkpoints') {
        const body = await readJson(request);
        assertRunId(body.runId);
        sendJson(response, 200, { checkpoint: await defaultCheckpointStore.getCheckpoint(body.runId) });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/rag/notes') {
        const body = await readJson(request);
        const note = await saveNote(body);
        const indexed = body.index === false ? null : await rag.indexCorpus({
          containerPath: note.containerPath,
          name: note.corpus,
        });
        sendJson(response, 200, { note, indexed });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/chat') {
        const body = await readJson(request);
        sendJson(response, 200, await chat(body.messages, body.model));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        const body = await readJson(request, 25_000_000); // imagens anexadas em base64 podem passar de 1 MB fácil
        runId = typeof body.runId === 'string' && body.runId ? body.runId : null;
        if (!runId) throw new Error('runId é obrigatório para streaming.');
        assertRunId(runId);
        const abortController = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) abortController.abort();
        });
        await streamChat(body.messages, body.model || DEFAULT_MODEL, runId, response, abortController, {
          activeSkills: body.activeSkills,
          projectPath: body.projectPath,
          corpus: body.corpus,
          toolsEnabled: body.toolsEnabled,
          memoryContextIncluded: body.memoryContextIncluded,
          sessionId: body.sessionId,
          sessionTitle: body.sessionTitle,
          conversationMemoryEnabled: body.conversationMemoryEnabled,
          maxTurns: body.maxTurns,
          maxContextChars: body.maxContextChars,
          maxDurationMs: body.maxDurationMs,
        });
        return;
      }

      sendJson(response, 404, { error: 'Rota não encontrada.' });
    } catch (error) {
      if (runId) {
        const status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
        defaultJobQueue.completeJob(runId, status);
        await defaultCheckpointStore.saveCheckpoint(runId, {
          status,
          failedAt: new Date().toISOString(),
          error: error?.message || 'Falha inesperada no backend.',
        }).catch(() => {});
      }
      const message = error?.name === 'TimeoutError'
        ? 'O modelo excedeu o tempo limite da requisição.'
        : error?.message || 'Falha inesperada no backend.';
      if (!response.headersSent) sendJson(response, 502, { error: message });
      else if (!response.writableEnded && runId) {
        response.end(`${JSON.stringify(createRunEvent(runId, EVENT_TYPES.RUN_FAILED, { error: message }))}\n`);
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ server, url: `http://${host}:${address.port}`, authToken });
    });
  });
}

module.exports = { startBackend };
