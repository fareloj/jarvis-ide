const http = require('node:http');

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
  const normalized = Array.isArray(messages)
    ? messages
        .filter((message) => message && ['system', 'user', 'assistant'].includes(message.role))
        .map((message) => ({ role: message.role, content: String(message.content || '').slice(0, 80_000) }))
        .slice(-40)
    : [];

  if (!normalized.some((message) => message.role === 'user')) {
    throw new Error('Envie ao menos uma mensagem do usuário.');
  }

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

function startBackend({ host = process.env.JARVIS_BACKEND_HOST || '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer(async (request, response) => {
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

      if (request.method === 'POST' && request.url === '/api/chat') {
        const body = await readJson(request);
        sendJson(response, 200, await chat(body.messages, body.model));
        return;
      }

      sendJson(response, 404, { error: 'Rota não encontrada.' });
    } catch (error) {
      const message = error?.name === 'TimeoutError'
        ? 'O modelo excedeu o tempo limite da requisição.'
        : error?.message || 'Falha inesperada no backend.';
      sendJson(response, 502, { error: message });
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
