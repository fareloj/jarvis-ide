// Runtime agentic robustecido para o JARVIS.
//
// Fornece orçamentos configuráveis (rodadas, tokens, tempo), compactação
// determinística de contexto, checkpoints versionados e atômicos com
// redação de segredos e idempotência de tools, retry seguro para falhas
// transitórias e gerenciador de jobs com cancelamento.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic } = require('./file-write');
const { killTree } = require('./problems-runner');

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_DIR = path.resolve(
  process.env.JARVIS_CHECKPOINT_PATH || path.join(__dirname, '..', 'data', 'checkpoints'),
);

const DEFAULT_BUDGET = {
  maxTurns: 10,
  maxContextChars: 80_000,
  maxDurationMs: 300_000, // 5 minutos
  maxRetries: 2,
};

const IDEMPOTENT_TOOLS = new Set([
  'rag_search',
  'web_search',
  'project_list_files',
  'project_read_file',
  'project_stat',
  'memory_list',
]);

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_\-.]+/gi,
  /(?:api[_-]?key|token|secret|password|auth|bearer)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-.]+)/gi,
  /(?:sk-[a-zA-Z0-9]{20,})/g,
  /(?:ghp_[a-zA-Z0-9]{36})/g,
];

function redactSecrets(input) {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    let sanitized = input;
    for (const pat of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pat, (match) => {
        if (/^bearer\s+/i.test(match)) {
          return 'Bearer [REDACTED_SECRET]';
        }
        return '[REDACTED_SECRET]';
      });
    }
    return sanitized;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item));
  }
  if (typeof input === 'object') {
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      const isSensitiveKey = ['password', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'auth'].some(
        (s) => lowerKey.includes(s),
      );
      if (isSensitiveKey && typeof value === 'string' && value.length > 0) {
        if (/^bearer\s+/i.test(value)) {
          output[key] = 'Bearer [REDACTED_SECRET]';
        } else {
          output[key] = '[REDACTED_SECRET]';
        }
      } else {
        output[key] = redactSecrets(value);
      }
    }
    return output;
  }
  return input;
}

function sortObjectKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((item) => sortObjectKeys(item));
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(runId)) {
    const error = new Error('runId inválido.');
    error.code = 'INVALID_RUN_ID';
    throw error;
  }
  return runId;
}

function getIdempotencyKey(runId, toolName, args = {}) {
  const canonicalArgs = JSON.stringify(sortObjectKeys(args) || {});
  const raw = `${runId}:${toolName}:${canonicalArgs}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function isIdempotentTool(toolName) {
  return IDEMPOTENT_TOOLS.has(String(toolName || ''));
}

function isTransientError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '').toLowerCase();

  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
  ]);

  if (transientCodes.has(code)) return true;

  if (
    msg.includes('http 502') ||
    msg.includes('http 503') ||
    msg.includes('http 504') ||
    msg.includes('http 429') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  ) {
    return true;
  }

  return false;
}

async function safeRetry(asyncFn, {
  maxRetries = 2,
  initialDelayMs = 100,
  isTransient = isTransientError,
  signal = null,
} = {}) {
  let attempt = 0;
  let delay = initialDelayMs;

  for (;;) {
    try {
      if (signal?.aborted) {
        throw signal.reason || Object.assign(new Error('Operação cancelada antes da execução.'), { name: 'AbortError' });
      }
      return await asyncFn();
    } catch (error) {
      attempt += 1;
      if (attempt > maxRetries || !isTransient(error) || signal?.aborted) {
        throw error;
      }
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason || Object.assign(new Error('Operação cancelada durante retry.'), { name: 'AbortError' }));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      delay = delay * 2;
    }
  }
}

/**
 * Compactação determinística de histórico de conversa:
 * Preserva mensagens de sistema, a mensagem inicial do usuário e as últimas
 * mensagens recentes, resumindo turnos intermediários de tools para não estourar
 * o contexto do modelo.
 */
function compactConversation(messages, { maxChars = DEFAULT_BUDGET.maxContextChars, preserveRecent = 6 } = {}) {
  if (!Array.isArray(messages) || !messages.length) return [];

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const safeMaxChars = Math.min(Math.max(Number(maxChars) || DEFAULT_BUDGET.maxContextChars, 4_000), 500_000);
  const safePreserveRecent = Math.min(Math.max(Number(preserveRecent) || 6, 2), 20);
  const totalChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
  if (totalChars <= safeMaxChars || nonSystemMessages.length <= safePreserveRecent + 1) {
    return messages;
  }

  // Preserva a primeira mensagem do usuário (requisito original)
  const firstUserIdx = nonSystemMessages.findIndex((m) => m.role === 'user');
  const firstUserMessage = firstUserIdx !== -1 ? nonSystemMessages[firstUserIdx] : null;

  // Preserva os últimos N turnos recentes
  const recentMessages = nonSystemMessages.slice(-safePreserveRecent);

  // Mensagens intermediárias que serão compactadas
  const intermediateMessages = nonSystemMessages.slice(firstUserIdx !== -1 ? firstUserIdx + 1 : 0, -safePreserveRecent);

  let toolCallsSummaryCount = 0;
  let toolResultsSummaryCount = 0;
  const priorUserRequirements = [];

  for (const msg of intermediateMessages) {
    if (msg.tool_calls) toolCallsSummaryCount += msg.tool_calls.length;
    if (msg.role === 'tool') toolResultsSummaryCount += 1;
    if (msg.role === 'user' && msg.content) {
      priorUserRequirements.push(String(msg.content).slice(0, 1_000));
    }
  }

  const compactSummaryMessage = {
    role: 'system',
    content: `Resumo estrutural: ${toolCallsSummaryCount} tool(s) solicitadas e ${toolResultsSummaryCount} resultado(s) processados. Nenhum conteúdo de tool ou do modelo foi promovido a instrução de sistema.`,
  };

  const compacted = [...systemMessages];
  if (firstUserMessage) compacted.push(firstUserMessage);
  compacted.push(compactSummaryMessage);
  if (priorUserRequirements.length) {
    compacted.push({
      role: 'user',
      content: `Solicitações anteriores do usuário que continuam fazendo parte do contexto:\n${JSON.stringify(priorUserRequirements.slice(-12))}`,
    });
  }
  compacted.push(...recentMessages);

  return compacted;
}

class CheckpointStore {
  constructor(storageDir = CHECKPOINT_DIR) {
    this.storageDir = storageDir;
    this.writeQueues = new Map();
  }

  async getCheckpointPath(runId) {
    return path.join(this.storageDir, `${assertRunId(runId)}.json`);
  }

  async withRunLock(runId, operation) {
    assertRunId(runId);
    const previous = this.writeQueues.get(runId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.writeQueues.set(runId, current);
    try {
      return await current;
    } finally {
      if (this.writeQueues.get(runId) === current) this.writeQueues.delete(runId);
    }
  }

  async saveCheckpointUnlocked(runId, data) {
    await fs.mkdir(this.storageDir, { recursive: true });

    const sanitizedData = redactSecrets(data);
    const checkpoint = {
      ...sanitizedData,
      version: CHECKPOINT_VERSION,
      runId,
      updatedAt: new Date().toISOString(),
    };

    const targetPath = await this.getCheckpointPath(runId);
    await writeAtomic(targetPath, JSON.stringify(checkpoint, null, 2));
    return checkpoint;
  }

  async saveCheckpoint(runId, data) {
    return this.withRunLock(runId, async () => {
      const existing = await this.getCheckpoint(runId);
      const merged = {
        ...(existing || {}),
        ...(data || {}),
        executedTools: {
          ...(existing?.executedTools || {}),
          ...(data?.executedTools || {}),
        },
      };
      return this.saveCheckpointUnlocked(runId, merged);
    });
  }

  async getCheckpoint(runId) {
    assertRunId(runId);
    try {
      const targetPath = await this.getCheckpointPath(runId);
      const raw = await fs.readFile(targetPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async recordExecutedTool(runId, toolName, args, result) {
    return this.withRunLock(runId, async () => {
      const key = getIdempotencyKey(runId, toolName, args);
      const existing = (await this.getCheckpoint(runId)) || {
        runId,
        createdAt: new Date().toISOString(),
        executedTools: {},
      };
      existing.executedTools = existing.executedTools || {};
      existing.executedTools[key] = {
        name: toolName,
        key,
        executedAt: new Date().toISOString(),
        result: redactSecrets(result),
      };
      await this.saveCheckpointUnlocked(runId, existing);
      return key;
    });
  }

  async hasExecutedTool(runId, toolName, args) {
    const key = getIdempotencyKey(runId, toolName, args);
    const existing = await this.getCheckpoint(runId);
    if (!existing || !existing.executedTools) return null;
    return existing.executedTools[key] || null;
  }
}

class JobQueue {
  constructor() {
    this.jobs = new Map(); // runId -> JobInfo
  }

  createJob({ runId, type = 'agent_run', projectPath, metadata = {}, abortController = null }) {
    assertRunId(runId);
    if (this.jobs.get(runId)?.status === 'running') throw new Error('Já existe um job ativo com este runId.');
    const job = {
      runId,
      type,
      projectPath,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata,
      events: [],
      pids: new Set(),
      abortController: abortController || new AbortController(),
    };
    this.jobs.set(runId, job);
    return job;
  }

  getJob(runId) {
    return this.jobs.get(runId) || null;
  }

  listJobs() {
    return Array.from(this.jobs.values()).map((job) => ({
      runId: job.runId,
      type: job.type,
      projectPath: job.projectPath,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      eventsCount: job.events.length,
    }));
  }

  appendEvent(runId, event) {
    const job = this.jobs.get(runId);
    if (job) {
      job.events.push(event);
      if (job.events.length > 1_000) job.events.splice(0, job.events.length - 1_000);
      job.updatedAt = new Date().toISOString();
    }
  }

  registerPid(runId, pid) {
    const job = this.jobs.get(runId);
    if (job && pid) {
      job.pids.add(pid);
    }
  }

  async cancelJob(runId) {
    const job = this.jobs.get(runId);
    if (!job) return false;
    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    job.abortController.abort();

    for (const pid of job.pids) {
      try {
        await killTree(pid);
      } catch {}
    }
    job.pids.clear();
    return true;
  }

  completeJob(runId, status = 'completed') {
    const job = this.jobs.get(runId);
    if (job) {
      job.status = status;
      job.updatedAt = new Date().toISOString();
    }
  }
}

const defaultCheckpointStore = new CheckpointStore();
const defaultJobQueue = new JobQueue();

module.exports = {
  CHECKPOINT_VERSION,
  DEFAULT_BUDGET,
  IDEMPOTENT_TOOLS,
  redactSecrets,
  assertRunId,
  getIdempotencyKey,
  isIdempotentTool,
  isTransientError,
  safeRetry,
  compactConversation,
  CheckpointStore,
  defaultCheckpointStore,
  JobQueue,
  defaultJobQueue,
};
