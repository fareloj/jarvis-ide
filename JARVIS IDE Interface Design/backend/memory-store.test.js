const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('memória persiste e pode ser listada por projeto', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-memory-project-'));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-memory-data-'));
  process.env.JARVIS_MEMORY_PATH = memoryRoot;
  const { listMemories, saveMemory } = require('./memory-store');
  const saved = await saveMemory({ projectPath: project, title: 'Banco', content: 'Usar PostgreSQL.', kind: 'decision' });
  const memories = await listMemories(project);
  assert.equal(memories[0].id, saved.memory.id);
  assert.equal(memories[0].kind, 'decision');
  await fs.rm(project, { recursive: true, force: true });
  await fs.rm(memoryRoot, { recursive: true, force: true });
});
