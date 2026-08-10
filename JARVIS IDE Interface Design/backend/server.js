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

function normalizeMessages(messages) {
  const normalized = Array.isArray(messages)
    ? messages
        .filter((message) => message && ['system', 'user', 'assistant'].includes(message.role))
        .map((message) => ({ role: message.role, content: String(message.content || '').slice(0, 80_000) }))
        .slice(-40)
    : [];

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

async function streamChat(messages, model, clientResponse, abortController) {
  const normalized = normalizeMessages(messages);
  const upstream = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: ollamaHeaders(),
    body: JSON.stringify({ model: model || DEFAULT_MODEL, messages: normalized, stream: true }),
    signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(180_000)]),
  });

  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => ({}));
    throw new Error(payload.error || `Ollama respondeu com HTTP ${upstream.status}.`);
  }

  clientResponse.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });

  const decoder = new TextDecoder();
  let pending = '';
  let doneSent = false;
  const relay = (line) => {
    if (!line.trim()) return;
    const payload = JSON.parse(line);
    const content = payload.message?.content || '';
    if (content) {
      clientResponse.write(`${JSON.stringify({ type: 'chunk', content, model: payload.model || model })}\n`);
    }
    if (payload.done && !doneSent) {
      doneSent = true;
      clientResponse.write(`${JSON.stringify({ type: 'done', model: payload.model || model })}\n`);
    }
  };

  for await (const chunk of upstream.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) relay(line);
  }
  pending += decoder.decode();
  relay(pending);
  if (!doneSent) clientResponse.write(`${JSON.stringify({ type: 'done', model: model || DEFAULT_MODEL })}\n`);
  clientResponse.end();
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

      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        const body = await readJson(request);
        const abortController = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) abortController.abort();
        });
        await streamChat(body.messages, body.model || DEFAULT_MODEL, response, abortController);
        return;
      }

      sendJson(response, 404, { error: 'Rota não encontrada.' });
    } catch (error) {
      const message = error?.name === 'TimeoutError'
        ? 'O modelo excedeu o tempo limite da requisição.'
        : error?.message || 'Falha inesperada no backend.';
      if (!response.headersSent) sendJson(response, 502, { error: message });
      else if (!response.writableEnded) response.end(`${JSON.stringify({ type: 'error', error: message })}\n`);
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
