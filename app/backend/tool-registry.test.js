const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  delegateCodingTask, getBackgroundJob, getTerminalJob, listProjectDirectory, previewProjectFile, publicDefinitions, requestTool, resolveApproval,
  resolveProjectTarget, runCli, saveProjectFile, startBackgroundJob, statProjectFile,
} = require('./tool-registry');

const ehWindows = process.platform === 'win32';

test('publicDefinitions pode omitir tools já satisfeitas pelo contexto', () => {
  const definitions = publicDefinitions({ exclude: ['memory_list'] });
  assert.equal(definitions.some((item) => item.function.name === 'memory_list'), false);
  assert.equal(definitions.some((item) => item.function.name === 'memory_save'), true);
});

test('tools de arquivo permanecem confinadas ao projeto', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tool-'));
  await fs.writeFile(path.join(root, 'hello.txt'), 'olá', 'utf8');
  await fs.writeFile(path.join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const result = await requestTool('project_read_file', { path: 'hello.txt' }, { projectPath: root });
  assert.equal(result.result.content, 'olá');
  const listed = await requestTool('project_list_files', {}, { projectPath: root });
  assert.deepEqual(listed.result.files, ['hello.txt']);
  await assert.rejects(
    requestTool('project_read_file', { path: 'photo.jpg' }, { projectPath: root }),
    /não é textual/,
  );
  assert.throws(() => resolveProjectTarget(root, '..\\secret.txt'), /fora do projeto/);
  await fs.rm(root, { recursive: true, force: true });
});

test('listProjectDirectory lista pastas e todos os tipos de arquivo (não só texto)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tree-'));
  await fs.mkdir(path.join(root, 'sub'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'hello.txt'), 'olá', 'utf8');
  await fs.writeFile(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(root, 'sub', 'nested.txt'), 'oi', 'utf8');

  const rootListing = await listProjectDirectory(root, '.');
  assert.deepEqual(rootListing.entries.map((entry) => entry.name), ['sub', 'hello.txt', 'photo.png']);
  assert.equal(rootListing.entries[0].type, 'dir');
  assert.equal(rootListing.entries.find((entry) => entry.name === 'photo.png').kind, 'image');

  const subListing = await listProjectDirectory(root, 'sub');
  assert.deepEqual(subListing.entries.map((entry) => entry.name), ['nested.txt']);

  await fs.rm(root, { recursive: true, force: true });
});

test('previewProjectFile devolve texto, imagem em base64 e fallback binário', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-preview-'));
  await fs.writeFile(path.join(root, 'hello.txt'), 'olá mundo', 'utf8');
  await fs.writeFile(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(root, 'app.exe'), Buffer.from([0x4d, 0x5a]));

  const text = await previewProjectFile(root, 'hello.txt');
  assert.equal(text.kind, 'text');
  assert.equal(text.content, 'olá mundo');

  const image = await previewProjectFile(root, 'photo.png');
  assert.equal(image.kind, 'image');
  assert.equal(image.mime, 'image/png');
  assert.equal(Buffer.from(image.base64, 'base64').equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), true);

  const binary = await previewProjectFile(root, 'app.exe');
  assert.equal(binary.kind, 'binary');
  assert.equal(binary.content, undefined);

  await fs.rm(root, { recursive: true, force: true });
});

test('delegate_coding_task exige aprovação explícita e valida entrada', async () => {
  const definition = publicDefinitions().find((item) => item.function.name === 'delegate_coding_task');
  assert.ok(definition, 'a tool delegate_coding_task deve estar registrada');
  assert.deepEqual(definition.function.parameters.required, ['agent', 'prompt']);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-delegate-'));
  const pending = await requestTool('delegate_coding_task', { agent: 'claude-code', prompt: 'oi' }, { projectPath: root });
  assert.equal(pending.status, 'approval_required');

  await assert.rejects(delegateCodingTask(root, 'claude-code', '   '), /não pode ser vazio/);
  await assert.rejects(delegateCodingTask(root, 'agente-inexistente', 'oi'), /desconhecido/);
  await fs.rm(root, { recursive: true, force: true });
});

test('terminal_run sempre para na aprovação, mesmo em leitura pura', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-terminal-'));
  for (const command of ['git status', 'ls', 'npm test']) {
    const pending = await requestTool('terminal_run', { command }, { projectPath: root });
    assert.equal(pending.status, 'approval_required', `${command} não pode rodar sozinho`);
    assert.equal(pending.approval.name, 'terminal_run');
    const denied = await resolveApproval(pending.approval.id, false);
    assert.equal(denied.status, 'denied');
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('terminal aprovado vira job em segundo plano e preserva o output final', { skip: !ehWindows }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-terminal-job-'));
  const pending = await requestTool('terminal_run', {
    command: "Start-Sleep -Milliseconds 350; Write-Output 'resultado-background'",
    timeout_seconds: 10,
  }, { projectPath: root, runId: 'runtime-terminal-background' });

  const startedAt = Date.now();
  const approved = await resolveApproval(pending.approval.id, true);
  assert.equal(approved.status, 'background');
  assert.equal(approved.job.status, 'running');
  assert.ok(Date.now() - startedAt < 300, 'aprovar não deve aguardar o comando terminar');

  let job = approved.job;
  const deadline = Date.now() + 5_000;
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    job = getTerminalJob(job.id);
  }
  assert.equal(job.status, 'completed');
  assert.match(job.result.stdout, /resultado-background/);
  assert.equal(job.result.exitCode, 0);
  assert.ok(job.result.duracaoMs >= 300);
  await fs.rm(root, { recursive: true, force: true });
});

test('job de terminal publica timeout e a saída parcial', { skip: !ehWindows }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-terminal-timeout-job-'));
  const pending = await requestTool('terminal_run', {
    command: "Write-Output 'antes-timeout'; Start-Sleep -Seconds 20",
    timeout_seconds: 1,
  }, { projectPath: root });
  const approved = await resolveApproval(pending.approval.id, true);

  let job = approved.job;
  const deadline = Date.now() + 8_000;
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 75); });
    job = getTerminalJob(job.id);
  }
  assert.equal(job.status, 'timeout');
  assert.equal(job.result.status, 'timeout');
  assert.match(job.result.stdout, /antes-timeout/);
  assert.notEqual(job.result.exitCode, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('job genérico de delegação publica output incremental e resultado', async () => {
  const job = startBackgroundJob({
    name: 'delegate_coding_task',
    args: { agent: 'antigravity', prompt: 'teste' },
    context: {},
  }, async (_name, _args, context) => {
    context.onStarted({ pid: 4242, cwd: os.tmpdir() });
    context.onMetadata({ externalId: 'agy-conversation-1', lastStep: 'agent_response', stepState: 'RUNNING' });
    context.onOutput('stdout', 'passo 1\n');
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    context.onOutput('stderr', 'aviso\n');
    return { agent: 'antigravity', result: 'tarefa concluída' };
  });
  assert.equal(job.status, 'running');
  assert.equal(job.name, 'delegate_coding_task');
  assert.equal(job.processId, 4242);
  assert.equal(job.externalId, 'agy-conversation-1');

  let completed = job;
  const deadline = Date.now() + 2_000;
  while (completed.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    completed = getBackgroundJob(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.match(completed.output.stdout, /passo 1/);
  assert.match(completed.output.stderr, /aviso/);
  assert.equal(completed.result.result, 'tarefa concluída');

  const status = await requestTool('background_job_status', { job_id: job.id }, {});
  assert.equal(status.status, 'completed');
  assert.equal(status.result.externalId, 'agy-conversation-1');
});

test('modo bypass inicia terminal sem criar aprovação', { skip: !ehWindows }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-terminal-bypass-'));
  const outcome = await requestTool('terminal_run', {
    command: "Write-Output 'bypass-ok'",
    timeout_seconds: 10,
  }, { projectPath: root, bypassCommands: true, runId: 'runtime-bypass' });
  assert.equal(outcome.status, 'background');

  let job = outcome.job;
  const deadline = Date.now() + 5_000;
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    job = getBackgroundJob(job.id);
  }
  assert.equal(job.status, 'completed');
  assert.match(job.result.stdout, /bypass-ok/);

  await assert.rejects(
    requestTool('terminal_run', {
      command: 'Get-Content "$env:windir\\System32\\drivers\\etc\\hosts"',
    }, { projectPath: root, bypassCommands: true }),
    /System32/i,
  );
  await fs.rm(root, { recursive: true, force: true });
});

// A CLI delegada abre o próprio runtime e o shell das tools: matar só o
// processo que abrimos deixaria essa descendência viva dentro do projeto.
const SCRIPT_COM_NETO = `
  const { spawn } = require('node:child_process');
  const marcador = process.argv[1];
  spawn(process.execPath, ['-e', "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),100)", marcador], { stdio: 'ignore' });
  setTimeout(() => {}, 60000);
`;

test('cancelar a delegação encerra a árvore de processos', { skip: !ehWindows }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-delegate-cancel-'));
  const marcador = path.join(root, 'neto.log');
  await fs.writeFile(marcador, '', 'utf8');

  const controle = new AbortController();
  setTimeout(() => controle.abort(), 900);

  const inicio = Date.now();
  await assert.rejects(
    runCli(process.execPath, ['-e', SCRIPT_COM_NETO, marcador], {
      cwd: root, timeoutMs: 30_000, signal: controle.signal,
    }),
    /cancelada/i,
  );
  assert.ok(Date.now() - inicio < 20_000, 'o cancelamento não pode esperar o timeout');

  // Dá tempo para uma escrita já bufferizada antes do taskkill chegar ao disco;
  // depois desse período o tamanho precisa permanecer estável.
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  const antes = (await fs.stat(marcador)).size;
  await new Promise((resolve) => { setTimeout(resolve, 1_200); });
  assert.equal((await fs.stat(marcador)).size, antes, 'o processo neto deveria estar encerrado');

  await fs.rm(root, { recursive: true, force: true });
});

test('timeout da delegação encerra a árvore e não deixa órfão', { skip: !ehWindows }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-delegate-timeout-'));
  const marcador = path.join(root, 'neto.log');
  await fs.writeFile(marcador, '', 'utf8');

  const inicio = Date.now();
  await assert.rejects(
    runCli(process.execPath, ['-e', SCRIPT_COM_NETO, marcador], { cwd: root, timeoutMs: 1_500 }),
    /tempo esgotado/i,
  );
  assert.ok(Date.now() - inicio < 20_000);

  await new Promise((resolve) => { setTimeout(resolve, 300); });
  const antes = (await fs.stat(marcador)).size;
  await new Promise((resolve) => { setTimeout(resolve, 1_200); });
  assert.equal((await fs.stat(marcador)).size, antes, 'o processo neto deveria estar encerrado');

  await fs.rm(root, { recursive: true, force: true });
});

test('tool de escrita exige aprovação explícita', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tool-approval-'));
  const pending = await requestTool('memory_save', { title: 'Teste', content: 'Persistir.' }, { projectPath: root });
  assert.equal(pending.status, 'approval_required');
  const denied = await resolveApproval(pending.approval.id, false);
  assert.equal(denied.status, 'denied');
  await fs.rm(root, { recursive: true, force: true });
});

test('aprovação devolve metadados internos do runtime para checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tool-runtime-'));
  const args = { title: 'Teste', content: 'Persistir.' };
  const pending = await requestTool('memory_save', args, { projectPath: root, runId: 'runtime-approval-123' });
  const denied = await resolveApproval(pending.approval.id, false);
  assert.deepEqual(denied._runtime, { runId: 'runtime-approval-123', args });
  await fs.rm(root, { recursive: true, force: true });
});

test('busca web entrega fontes estruturadas ao agente', async (context) => {
  const originalFetch = global.fetch;
  const originalProvider = process.env.JARVIS_WEB_SEARCH_PROVIDER;
  process.env.JARVIS_WEB_SEARCH_PROVIDER = 'bing'; // sem chave do Tavily/Brave no ambiente de teste, força o provedor sem-chave que este teste valida
  global.fetch = async () => new Response(`
    <rss><channel><item><title>Documentação</title><link>https://example.com/docs</link>
    <description>Referência &amp; exemplo.</description></item></channel></rss>
  `, { status: 200 });
  context.after(() => {
    global.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.JARVIS_WEB_SEARCH_PROVIDER;
    else process.env.JARVIS_WEB_SEARCH_PROVIDER = originalProvider;
  });

  const definition = publicDefinitions().find((item) => item.function.name === 'web_search');
  assert.ok(definition);
  const outcome = await requestTool('web_search', { query: 'JARVIS documentação', max_results: 3 }, {});
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result.untrusted, true);
  assert.deepEqual(outcome.result.results, [{
    title: 'Documentação', url: 'https://example.com/docs', snippet: 'Referência & exemplo.',
  }]);
});

test('salvar pelo editor grava, devolve o hash e detecta edição concorrente', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-editor-'));
  await fs.writeFile(path.join(root, 'app.js'), 'const a = 1;\n', 'utf8');

  const antes = await statProjectFile(root, 'app.js');
  assert.equal(antes.kind, 'text');
  assert.ok(antes.hash, 'o editor precisa de um hash base para detectar conflito');

  const salvo = await saveProjectFile({
    projectPath: root, path: 'app.js', content: 'const a = 2;\n', baseHash: antes.hash,
  });
  assert.equal(salvo.tipo, 'atualizar');
  assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'const a = 2;\n');

  const depois = await statProjectFile(root, 'app.js');
  assert.equal(depois.hash, salvo.hash, 'o hash devolvido é o que o disco passa a ter');

  // Alguém mexe no arquivo enquanto a aba continua com o hash antigo.
  await fs.writeFile(path.join(root, 'app.js'), 'editado por fora\n', 'utf8');
  await assert.rejects(
    saveProjectFile({ projectPath: root, path: 'app.js', content: 'const a = 3;\n', baseHash: salvo.hash }),
    (erro) => erro.code === 'CONFLITO',
  );
  assert.equal(
    await fs.readFile(path.join(root, 'app.js'), 'utf8'),
    'editado por fora\n',
    'conflito não pode sobrescrever a edição de terceiro',
  );

  await fs.rm(root, { recursive: true, force: true });
});

test('salvar pelo editor herda a fronteira da escrita do agente', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-editor-limite-'));

  await assert.rejects(
    saveProjectFile({ projectPath: root, path: '../fora.txt', content: 'x' }),
    /sai do projeto/i,
  );
  await assert.rejects(
    saveProjectFile({ projectPath: root, path: 'C:/Windows/system32/x.txt', content: 'x' }),
    /caminho relativo/i,
  );
  await assert.rejects(
    saveProjectFile({ projectPath: root, path: 'programa.exe', content: 'x' }),
    /Extensão não permitida/i,
  );

  // Arquivo novo criado pelo "salvar como" continua valendo.
  const criado = await saveProjectFile({ projectPath: root, path: 'novo/doc.md', content: '# oi\n', baseHash: null });
  assert.equal(criado.tipo, 'criar');
  assert.equal(await fs.readFile(path.join(root, 'novo', 'doc.md'), 'utf8'), '# oi\n');

  await fs.rm(root, { recursive: true, force: true });
});

test('arquivo binário e arquivo grande não recebem hash de edição', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-editor-grande-'));
  await fs.writeFile(path.join(root, 'app.exe'), Buffer.from([0x4d, 0x5a]));
  await fs.writeFile(path.join(root, 'enorme.txt'), 'x'.repeat(900_000), 'utf8');

  const binario = await statProjectFile(root, 'app.exe');
  assert.equal(binario.kind, 'binary');
  assert.equal(binario.hash, null, 'binário não entra no editor, então não tem hash base');

  const grande = await statProjectFile(root, 'enorme.txt');
  assert.equal(grande.hash, null, 'acima do limite de pré-visualização o editor não abre o arquivo');
  await assert.rejects(previewProjectFile(root, 'enorme.txt'), /grande demais/i);

  await fs.rm(root, { recursive: true, force: true });
});
