const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-server-memory-'));
process.env.JARVIS_MEMORY_PATH = memoryRoot;
const { startBackend } = require('./server');

function requestJson(url, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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

function requestText(url, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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
  const chatPayloads = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (String(url).endsWith('/api/chat')) {
      const payload = JSON.parse(options.body);
      chatPayloads.push(payload);
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
    fs.rmSync(memoryRoot, { recursive: true, force: true });
  });

  const health = await requestJson(`${backend.url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.ollama.online, true);

  const chat = await requestJson(`${backend.url}/api/chat`, {
    method: 'POST',
    token: backend.authToken,
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
    token: backend.authToken,
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

  const projectPath = path.join(os.tmpdir(), 'jarvis-project-memory-context');
  const savedMemory = await requestJson(`${backend.url}/api/memory`, {
    method: 'POST',
    token: backend.authToken,
    body: {
      projectPath,
      title: 'Banco principal',
      content: 'O projeto usa PostgreSQL.',
      kind: 'decision',
    },
  });
  assert.equal(savedMemory.status, 200);

  const memoryStream = await requestText(`${backend.url}/api/chat/stream`, {
    method: 'POST',
    token: backend.authToken,
    body: {
      model: 'gpt-oss:120b-cloud',
      runId: 'run-memory-context',
      projectPath,
      messages: [{ role: 'user', content: 'Olá, JARVIS' }],
    },
  });
  assert.equal(memoryStream.status, 200);
  const memoryPrompt = chatPayloads.at(-1).messages.find((message) => (
    message.role === 'system' && message.content.includes('Memória persistente do projeto')
  ));
  assert.ok(memoryPrompt);
  assert.match(memoryPrompt.content, /Banco principal: O projeto usa PostgreSQL\./);
  assert.equal(
    chatPayloads.at(-1).tools.some((tool) => tool.function.name === 'memory_list'),
    false,
    'memory_list é redundante quando a memória já foi incluída no prompt',
  );
  assert.equal(chatPayloads.at(-1).tools.some((tool) => tool.function.name === 'memory_save'), true);
  assert.equal(events.map((event) => event.payload.content || '').join(''), 'Olá! **Tudo bem?**');
});

test('anexos de imagem chegam até o Ollama e mensagens sem imagem não ganham o campo', async (context) => {
  const originalFetch = global.fetch;
  const chatPayloads = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    if (String(url).endsWith('/api/chat')) {
      const payload = JSON.parse(options.body);
      chatPayloads.push(payload);
      return new Response(`${JSON.stringify({
        model: payload.model, message: { content: '' }, done: true,
      })}\n`, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    throw new Error(`URL inesperada no teste: ${url}`);
  };

  const backend = await startBackend();
  context.after(() => {
    backend.server.close();
    global.fetch = originalFetch;
  });

  await requestText(`${backend.url}/api/chat/stream`, {
    method: 'POST',
    token: backend.authToken,
    body: {
      model: 'gpt-oss:120b-cloud',
      runId: 'run-image-attachment',
      messages: [
        { role: 'user', content: 'Sem imagem aqui.' },
        { role: 'user', content: 'O que tem nessa foto?', images: ['ZmFrZS1iYXNlNjQ='] },
      ],
    },
  });

  const sent = chatPayloads.at(0).messages;
  const noImageMessage = sent.find((message) => message.content === 'Sem imagem aqui.');
  const imageMessage = sent.find((message) => message.content === 'O que tem nessa foto?');
  assert.ok(noImageMessage);
  assert.equal('images' in noImageMessage, false);
  assert.deepEqual(imageMessage.images, ['ZmFrZS1iYXNlNjQ=']);
});

test('primeira tentativa de tool operacional divulga a skill e so a segunda pede aprovacao', async (context) => {
  const originalFetch = global.fetch;
  const payloads = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    if (!String(url).endsWith('/api/chat')) throw new Error(`URL inesperada no teste: ${url}`);
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    return new Response(`${JSON.stringify({
      model: payload.model,
      message: {
        content: '',
        tool_calls: [{
          function: {
            name: 'inspect_coding_agent',
            arguments: { agent: 'codex', capability: 'version' },
          },
        }],
      },
      done: true,
    })}\n`, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };

  const backend = await startBackend();
  context.after(() => {
    backend.server.close();
    global.fetch = originalFetch;
  });

  const response = await requestText(`${backend.url}/api/chat/stream`, {
    method: 'POST',
    token: backend.authToken,
    body: {
      model: 'gpt-oss:120b-cloud',
      runId: 'run-tool-skill-gate',
      projectPath: os.tmpdir(),
      activeSkills: [],
      messages: [{ role: 'user', content: 'Qual versao do Codex esta instalada?' }],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(payloads.length, 2, 'a skill deve voltar ao modelo antes da segunda tool call');
  const disclosed = payloads[1].messages.find((message) => (
    message.role === 'tool' && String(message.content).includes('skill_loaded')
  ));
  assert.ok(disclosed);
  assert.match(disclosed.content, /inspect-coding-agent/);
  assert.match(disclosed.content, /Escolher capacidade suportada/);
  const disclosure = JSON.parse(disclosed.content);
  assert.equal(disclosure.executed, false);
  assert.equal(disclosure.approval_requested, false);
  assert.equal(disclosure.job_created, false);
  assert.match(disclosure.next_action, /ainda nao executou/i);

  const events = response.body.trim().split('\n').map((line) => JSON.parse(line));
  const toolResults = events.filter((event) => event.type === 'tool.result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].payload.skillDisclosure, true);
  assert.ok(events.some((event) => event.type === 'approval.required'));
});

test('chamadas paralelas da mesma skill aguardam juntas antes de executar', async (context) => {
  const originalFetch = global.fetch;
  const payloads = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    return new Response(`${JSON.stringify({
      model: payload.model,
      message: {
        content: '',
        tool_calls: ['codex', 'claude-code'].map((agent) => ({
          function: { name: 'inspect_coding_agent', arguments: { agent, capability: 'version' } },
        })),
      },
      done: true,
    })}\n`, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };

  const backend = await startBackend();
  context.after(() => {
    backend.server.close();
    global.fetch = originalFetch;
  });
  const response = await requestText(`${backend.url}/api/chat/stream`, {
    method: 'POST',
    token: backend.authToken,
    body: {
      model: 'gpt-oss:120b-cloud',
      runId: 'run-parallel-skill-gate',
      projectPath: os.tmpdir(),
      activeSkills: [],
      messages: [{ role: 'user', content: 'Inspecione os dois agentes.' }],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(payloads.length, 2);
  const disclosures = payloads[1].messages.filter((message) => (
    message.role === 'tool' && String(message.content).includes('skill_loaded')
  ));
  assert.equal(disclosures.length, 2, 'nenhuma chamada paralela pode furar o gate da skill no mesmo turno');
  const events = response.body.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'tool.result' && event.payload.skillDisclosure).length, 2);
  assert.equal(events.filter((event) => event.type === 'approval.required').length, 2);
});

test('allowlist remota nunca oferece tools fora do conjunto informado', async (context) => {
  const originalFetch = global.fetch;
  let offered = [];
  global.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    offered = (body.tools || []).map((tool) => tool.function.name);
    return new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true })}\n`, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  };
  const backend = await startBackend();
  context.after(() => {
    backend.server.close();
    global.fetch = originalFetch;
  });

  const response = await requestText(`${backend.url}/api/chat/stream`, {
    method: 'POST',
    token: backend.authToken,
    body: {
      model: 'gpt-oss:120b-cloud',
      runId: 'run-mobile-tool-allowlist',
      sessionId: 'mobile-session',
      toolsEnabled: true,
      allowedTools: ['web_search', 'rag_search'],
      conversationMemoryEnabled: false,
      messages: [{ role: 'user', content: 'Pesquise um assunto suficientemente detalhado.' }],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(offered.sort(), ['rag_search', 'web_search']);
  assert.equal(offered.includes('terminal_run'), false);
  assert.equal(offered.includes('project_write_file'), false);
});
