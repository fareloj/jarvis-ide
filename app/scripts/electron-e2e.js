const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJson(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-electron-e2e-'));
  const projectPath = path.join(root, 'project');
  const outputDirectory = path.join(root, 'artifacts');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'README.md'), '# E2E fixture\n');
  let chatCalls = 0;
  const mock = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/tags') return sendJson(response, { models: [{ name: 'e2e:cloud', model: 'e2e:cloud' }] });
    if (request.method === 'GET' && request.url === '/health') return sendJson(response, { status: 'ok', dense_count: 1, lexical_count: 1 });
    if (request.method === 'POST' && request.url === '/v1/search') return sendJson(response, { results: [] });
    if (request.method === 'POST' && request.url === '/api/chat') {
      const body = await readBody(request);
      chatCalls += 1;
      response.writeHead(200, { 'Content-Type': body.stream ? 'application/x-ndjson' : 'application/json' });
      if (!body.stream) return response.end(JSON.stringify({ model: 'e2e:cloud', message: { content: '{"action":"none"}' }, done: true }));
      const completedTool = body.messages.some((message) => String(message.content || '').includes('DADOS_DA_TOOL_'));
      const payload = completedTool
        ? { model: 'e2e:cloud', message: { role: 'assistant', content: 'E2E concluÃ­do com o arquivo aprovado.' }, done: true }
        : { model: 'e2e:cloud', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'project_write_file', arguments: { path: 'e2e-created.txt', content: 'validado\n' } } }] }, done: true };
      return response.end(`${JSON.stringify(payload)}\n`);
    }
    sendJson(response, {});
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = mock.address().port;
  let electron;
  try {
    electron = process.env.JARVIS_ELECTRON_PATH || require('electron');
  } catch (error) {
    mock.closeAllConnections?.();
    await new Promise((resolve) => mock.close(resolve));
    throw new Error(`Runtime do Electron indisponÃ­vel: ${error.message}`);
  }
  const child = spawn(electron, [`--user-data-dir=${path.join(root, 'user-data')}`, '.'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      JARVIS_E2E_PROJECT: projectPath,
      JARVIS_E2E_OUTPUT: outputDirectory,
      JARVIS_OLLAMA_HOST: `http://127.0.0.1:${port}`,
      JARVIS_RAG_ENDPOINT: `http://127.0.0.1:${port}`,
      JARVIS_OLLAMA_MODEL: 'e2e:cloud',
      JARVIS_SKILL_REVIEW_MODEL: 'e2e:cloud',
      JARVIS_MOBILE_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { logs += chunk; process.stderr.write(chunk); });
  const timeout = setTimeout(() => {
    if (process.platform === 'win32') execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], () => {});
    else child.kill('SIGKILL');
  }, 45_000);
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timeout);
  mock.closeAllConnections?.();
  await new Promise((resolve) => mock.close(resolve));
  const reportPath = path.join(outputDirectory, 'electron-e2e-report.json');
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8').catch(() => '{"status":"missing"}'));
  if (exitCode !== 0 || report.status !== 'passed') {
    console.error(`E2E artifacts: ${outputDirectory}`);
    console.error(logs.slice(-20_000));
    process.exitCode = 1;
    return;
  }
  console.log(`Electron E2E passed (${report.checks.length} checks, ${chatCalls} model calls).`);
  console.log(`Artifacts: ${outputDirectory}`);
  await fs.rm(root, { recursive: true, force: true });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
