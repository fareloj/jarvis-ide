const http = require('node:http');
const { EVENT_TYPES, createRunEvent } = require('./protocol');
const rag = require('./rag-client');
const { saveNote, stageProject } = require('./workspace-indexer');
const { formatMemoriesForPrompt, listMemories, saveMemory } = require('./memory-store');
const { formatSkillsForPrompt, listSkills, loadActiveSkills } = require('./skill-loader');
const tools = require('./tool-registry');

const DEFAULT_MODEL = process.env.JARVIS_OLLAMA_MODEL || 'gpt-oss:120b-cloud';
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

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('A requisição excede o limite de 1 MB.');
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
        .map((message) => ({ role: message.role, content: String(message.content || '').slice(0, 80_000) }))
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

async function chat(messages, model = DEFAULT_MODEL) {
  const normalized = normalizeMessages(messages);

  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: ollamaHeaders(),
    body: JSON.stringify({ model, messages: normalized, stream: false }),
    signal: AbortSignal.timeout(180_000),
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

async function streamChat(messages, model, runId, clientResponse, abortController, options = {}) {
  const conversation = normalizeMessages(messages);
  const activeSkills = await loadActiveSkills(options.activeSkills);
  const skillPrompt = formatSkillsForPrompt(activeSkills);
  const memories = options.projectPath ? await listMemories(options.projectPath) : [];
  const memoryPrompt = formatMemoriesForPrompt(memories);
  if (skillPrompt) conversation.unshift({ role: 'system', content: skillPrompt });
  if (memoryPrompt) conversation.unshift({ role: 'system', content: `Memória persistente do projeto:\n${memoryPrompt}` });
  clientResponse.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });

  let doneSent = false;
  const emit = (type, payload) => clientResponse.write(`${JSON.stringify(createRunEvent(runId, type, payload))}\n`);

  for (let turn = 0; turn < 5 && !doneSent; turn += 1) {
    const upstream = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: ollamaHeaders(),
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: conversation,
        stream: true,
        tools: options.toolsEnabled === false ? undefined : tools.publicDefinitions(),
      }),
      signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(180_000)]),
    });
    if (!upstream.ok) {
      const payload = await upstream.json().catch(() => ({}));
      throw new Error(payload.error || `Ollama respondeu com HTTP ${upstream.status}.`);
    }

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
      emit(EVENT_TYPES.MESSAGE_DONE, { model: model || DEFAULT_MODEL });
      break;
    }

    conversation.push({ role: 'assistant', content: assistantContent, tool_calls: toolCalls });
    let approvalRequired = false;
    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') args = JSON.parse(args || '{}');
      emit(EVENT_TYPES.TOOL_REQUESTED, { name, args });
      const outcome = await tools.requestTool(name, args, {
        projectPath: options.projectPath,
        corpus: options.corpus,
      });
      if (outcome.status === 'approval_required') {
        approvalRequired = true;
        emit(EVENT_TYPES.APPROVAL_REQUIRED, outcome.approval);
        continue;
      }
      const result = JSON.stringify(outcome.result).slice(0, 120_000);
      emit(EVENT_TYPES.TOOL_RESULT, { name, result: outcome.result });
      conversation.push({ role: 'tool', tool_name: name, content: result });
    }
    if (approvalRequired) {
      doneSent = true;
      emit(EVENT_TYPES.MESSAGE_DONE, { model: model || DEFAULT_MODEL, awaitingApproval: true });
    }
  }
  if (!doneSent) {
    emit(EVENT_TYPES.RUN_FAILED, { error: 'O agente excedeu o limite de chamadas de tools.' });
  }
  clientResponse.end();
}

function startBackend({ host = process.env.JARVIS_BACKEND_HOST || '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer(async (request, response) => {
    let runId = null;
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': 'null',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      response.end();
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
        sendJson(response, 200, { skills: (await listSkills()).map(({ content, ...skill }) => skill) });
        return;
      }

      if (request.method === 'GET' && request.url === '/api/tools') {
        sendJson(response, 200, { tools: tools.describeTools() });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/tools/approval') {
        const body = await readJson(request);
        sendJson(response, 200, await tools.resolveApproval(body.id, body.approved === true));
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
        const body = await readJson(request);
        runId = typeof body.runId === 'string' && body.runId ? body.runId : null;
        if (!runId) throw new Error('runId é obrigatório para streaming.');
        const abortController = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) abortController.abort();
        });
        await streamChat(body.messages, body.model || DEFAULT_MODEL, runId, response, abortController, {
          activeSkills: body.activeSkills,
          projectPath: body.projectPath,
          corpus: body.corpus,
          toolsEnabled: body.toolsEnabled,
        });
        return;
      }

      sendJson(response, 404, { error: 'Rota não encontrada.' });
    } catch (error) {
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
      resolve({ server, url: `http://${host}:${address.port}` });
    });
  });
}

module.exports = { startBackend };
