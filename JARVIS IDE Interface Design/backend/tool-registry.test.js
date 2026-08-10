const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { requestTool, resolveApproval, resolveProjectTarget } = require('./tool-registry');

test('tools de arquivo permanecem confinadas ao projeto', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tool-'));
  await fs.writeFile(path.join(root, 'hello.txt'), 'olá', 'utf8');
  const result = await requestTool('project_read_file', { path: 'hello.txt' }, { projectPath: root });
  assert.equal(result.result.content, 'olá');
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

