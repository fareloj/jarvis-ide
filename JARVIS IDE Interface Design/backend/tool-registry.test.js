const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { publicDefinitions, requestTool, resolveApproval, resolveProjectTarget } = require('./tool-registry');

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
  global.fetch = async () => new Response(`
    <rss><channel><item><title>Documentação</title><link>https://example.com/docs</link>
    <description>Referência &amp; exemplo.</description></item></channel></rss>
  `, { status: 200 });
  context.after(() => { global.fetch = originalFetch; });

  const definition = publicDefinitions().find((item) => item.function.name === 'web_search');
  assert.ok(definition);
  const outcome = await requestTool('web_search', { query: 'JARVIS documentação', max_results: 3 }, {});
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result.untrusted, true);
  assert.deepEqual(outcome.result.results, [{
    title: 'Documentação', url: 'https://example.com/docs', snippet: 'Referência & exemplo.',
  }]);
});
