const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function configureRoots(temporaryRoot, staging) {
  process.env.JARVIS_RAG_STAGING_PATH = staging;
  process.env.JARVIS_RAG_MANIFEST_PATH = path.join(temporaryRoot, 'manifests');
  process.env.JARVIS_RAG_NOTES_PATH = path.join(temporaryRoot, 'notes');
  delete require.cache[require.resolve('./workspace-indexer')];
}

test('staging copia somente arquivos textuais permitidos', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-indexer-'));
  const project = path.join(temporaryRoot, 'project');
  const staging = path.join(temporaryRoot, 'staging');
  await fs.mkdir(path.join(project, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# Projeto', 'utf8');
  await fs.writeFile(path.join(project, 'image.png'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(project, 'node_modules', 'ignored.js'), 'ignored', 'utf8');
  configureRoots(temporaryRoot, staging);
  const { listCorpusDocuments, stageProject } = require('./workspace-indexer');
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const result = await stageProject(project);
  assert.equal(result.fileCount, 1);
  assert.equal(await fs.readFile(path.join(result.hostPath, 'README.md'), 'utf8'), '# Projeto');
  await assert.rejects(() => fs.stat(path.join(result.hostPath, 'image.png')), /ENOENT/);
  const inventory = await listCorpusDocuments({ corpus: result.corpus });
  assert.deepEqual(inventory.documents.map((item) => item.path), ['README.md']);
  assert.equal(inventory.totalBytes, 9);
});

test('staging incremental identifica arquivos inalterados, alterados e removidos', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-indexer-incremental-'));
  const project = path.join(temporaryRoot, 'project');
  const staging = path.join(temporaryRoot, 'staging');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'keep.md'), 'igual', 'utf8');
  await fs.writeFile(path.join(project, 'remove.md'), 'remover', 'utf8');
  configureRoots(temporaryRoot, staging);
  const { stageProject } = require('./workspace-indexer');
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const first = await stageProject(project);
  assert.deepEqual(first.changed.sort(), ['keep.md', 'remove.md']);
  await fs.rm(path.join(project, 'remove.md'));
  await fs.writeFile(path.join(project, 'new.md'), 'novo', 'utf8');
  const second = await stageProject(project);
  assert.deepEqual(second.unchanged, ['keep.md']);
  assert.deepEqual(second.changed, ['new.md']);
  assert.deepEqual(second.deleted, ['remove.md']);
  await assert.rejects(() => fs.stat(path.join(second.hostPath, 'remove.md')), /ENOENT/);
});

test('notas com id estavel podem ser atualizadas e removidas do staging', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-indexer-note-'));
  const project = path.join(temporaryRoot, 'project');
  const staging = path.join(temporaryRoot, 'staging');
  await fs.mkdir(project, { recursive: true });
  configureRoots(temporaryRoot, staging);
  const { deleteNote, saveNote } = require('./workspace-indexer');
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const first = await saveNote({ projectPath: project, noteId: 'memory-123', title: 'Um', content: 'antes' });
  const updated = await saveNote({ projectPath: project, noteId: 'memory-123', title: 'Dois', content: 'depois' });
  assert.equal(first.path, updated.path);
  assert.match(await fs.readFile(updated.path, 'utf8'), /depois/);
  await deleteNote({ projectPath: project, noteId: 'memory-123' });
  await assert.rejects(() => fs.stat(updated.path), /ENOENT/);
});
