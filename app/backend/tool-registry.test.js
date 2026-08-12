const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  delegateCodingTask, listProjectDirectory, previewProjectFile, publicDefinitions, requestTool, resolveApproval,
  resolveProjectTarget,
} = require('./tool-registry');

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

test('tool de escrita exige aprovação explícita', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tool-approval-'));
  const pending = await requestTool('memory_save', { title: 'Teste', content: 'Persistir.' }, { projectPath: root });
  assert.equal(pending.status, 'approval_required');
  const denied = await resolveApproval(pending.approval.id, false);
  assert.equal(denied.status, 'denied');
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
