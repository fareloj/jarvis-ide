const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('staging copia somente arquivos textuais permitidos', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-indexer-'));
  const project = path.join(temporaryRoot, 'project');
  const staging = path.join(temporaryRoot, 'staging');
  await fs.mkdir(path.join(project, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# Projeto', 'utf8');
  await fs.writeFile(path.join(project, 'image.png'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(project, 'node_modules', 'ignored.js'), 'ignored', 'utf8');
  process.env.JARVIS_RAG_STAGING_PATH = staging;
  delete require.cache[require.resolve('./workspace-indexer')];
  const { stageProject } = require('./workspace-indexer');
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const result = await stageProject(project);
  assert.equal(result.fileCount, 1);
  assert.equal(await fs.readFile(path.join(result.hostPath, 'README.md'), 'utf8'), '# Projeto');
  await assert.rejects(() => fs.stat(path.join(result.hostPath, 'image.png')), /ENOENT/);
});
