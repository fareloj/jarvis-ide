const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startBackend } = require('./server');

function requestJson(url, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

function requestText(url, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

test('health e chat preservam o contrato do frontend', async (context) => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (String(url).endsWith('/api/chat')) {
      const payload = JSON.parse(options.body);
      assert.equal(payload.messages.at(-1).content, 'Olá, JARVIS');
      if (payload.stream) {
        const chunks = [
          JSON.stringify({ model: payload.model, message: { content: 'Olá' }, done: false }),
          JSON.stringify({ model: payload.model, message: { content: '! **Tudo bem?**' }, done: false }),
          JSON.stringify({ model: payload.model, message: { content: '' }, done: true }),
        ];
        return new Response(`${chunks.join('\n')}\n`, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }
      assert.equal(payload.stream, false);
      return new Response(JSON.stringify({
        model: payload.model,
        done: true,
        message: { role: 'assistant', content: 'Olá! Como posso ajudar?' },
      }), { status: 200 });
    }
    throw new Error(`URL inesperada no teste: ${url}`);
  };

  const backend = await startBackend();
  context.after(() => {
    backend.server.close();
    global.fetch = originalFetch;
  });

  const health = await requestJson(`${backend.url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.ollama.online, true);

  const chat = await requestJson(`${backend.url}/api/chat`, {
    method: 'POST',
    body: {
      model: 'gpt-oss:120b-cloud',
      messages: [{ role: 'user', content: 'Olá, JARVIS' }],
    },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.message, 'Olá! Como posso ajudar?');
  assert.equal(chat.body.model, 'gpt-oss:120b-cloud');

  const streamed = await requestText(`${backend.url}/api/chat/stream`, {
    method: 'POST',
    body: {
      model: 'gpt-oss:120b-cloud',
      runId: 'run-test-1',
      messages: [{ role: 'user', content: 'Olá, JARVIS' }],
    },
  });
  assert.equal(streamed.status, 200);
  const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['message.delta', 'message.delta', 'message.done']);
  assert.ok(events.every((event) => event.runId === 'run-test-1'));
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.timestamp))));
  assert.equal(events.map((event) => event.payload.content || '').join(''), 'Olá! **Tudo bem?**');
});
