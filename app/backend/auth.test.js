const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-auth-'));
process.env.JARVIS_MEMORY_PATH = memoryRoot;
const { startBackend } = require('./server');

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('rotas privadas recusam requisição sem token', async (context) => {
  const backend = await startBackend();
  context.after(() => backend.server.close());

  // Uma rota de leitura e uma de escrita: nenhuma pode responder a quem
  // apenas descobriu a porta.
  const leitura = await request(`${backend.url}/api/skills`);
  assert.equal(leitura.status, 401);

  const escrita = await request(`${backend.url}/api/memory`, {
    method: 'POST',
    body: { projectPath: memoryRoot, title: 'x', content: 'y' },
  });
  assert.equal(escrita.status, 401);
  assert.match(escrita.body, /não autenticada/i);
});

test('token inválido ou de formato errado é recusado', async (context) => {
  const backend = await startBackend();
  context.after(() => backend.server.close());

  const casos = [
    { Authorization: 'Bearer token-errado' },
    { Authorization: `Bearer ${backend.authToken}x` }, // tamanho diferente
    { Authorization: backend.authToken }, // sem o esquema Bearer
    { Authorization: 'Basic dXNlcjpwYXNz' },
    { Authorization: 'Bearer ' },
  ];
  for (const headers of casos) {
    const resposta = await request(`${backend.url}/api/skills`, { headers });
    assert.equal(resposta.status, 401, `deveria recusar: ${JSON.stringify(headers)}`);
  }
});

test('requisição autenticada é atendida normalmente', async (context) => {
  const backend = await startBackend();
  context.after(() => backend.server.close());

  const resposta = await request(`${backend.url}/api/skills`, {
    headers: { Authorization: `Bearer ${backend.authToken}` },
  });
  assert.equal(resposta.status, 200);
  assert.ok(JSON.parse(resposta.body).skills, 'a rota deve responder o payload real');
});

test('o health check permanece público para diagnóstico', async (context) => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ models: [] }), { status: 200 });
  const backend = await startBackend();
  context.after(() => {
    backend.server.close();
    global.fetch = originalFetch;
  });

  const resposta = await request(`${backend.url}/health`);
  assert.equal(resposta.status, 200);
  assert.doesNotMatch(resposta.body, new RegExp(backend.authToken), 'o health nunca pode devolver o token');
});

test('o token muda a cada inicialização', async (context) => {
  const primeiro = await startBackend();
  const segundo = await startBackend();
  context.after(() => { primeiro.server.close(); segundo.server.close(); });

  assert.notEqual(primeiro.authToken, segundo.authToken);
  assert.equal(primeiro.authToken.length, 64, '32 bytes em hexadecimal');
  assert.match(primeiro.authToken, /^[0-9a-f]{64}$/);

  // O token de uma instância não pode abrir a outra.
  const cruzado = await request(`${segundo.url}/api/skills`, {
    headers: { Authorization: `Bearer ${primeiro.authToken}` },
  });
  assert.equal(cruzado.status, 401);
});

test('métodos e origens inesperadas são recusados antes da rota', async (context) => {
  const backend = await startBackend();
  context.after(() => backend.server.close());

  const autorizado = { Authorization: `Bearer ${backend.authToken}` };

  const metodo = await request(`${backend.url}/api/skills`, { method: 'DELETE', headers: autorizado });
  assert.equal(metodo.status, 405);

  // Uma página web mal-intencionada enviaria a própria origem; o renderer
  // carrega por file:// e manda "null".
  const origem = await request(`${backend.url}/api/skills`, {
    headers: { ...autorizado, Origin: 'https://exemplo.invalido' },
  });
  assert.equal(origem.status, 403);
});

test.after(() => fs.rmSync(memoryRoot, { recursive: true, force: true }));
