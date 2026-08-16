const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('memória persiste e pode ser listada por projeto', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-memory-project-'));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-memory-data-'));
  process.env.JARVIS_MEMORY_PATH = memoryRoot;
  const { deleteMemory, exportMemories, listMemories, saveMemory, updateMemory } = require('./memory-store');
  const saved = await saveMemory({ projectPath: project, title: 'Banco', content: 'Usar PostgreSQL.', kind: 'decision' });
  const duplicate = await saveMemory({ projectPath: project, title: 'Banco principal', content: 'Usar PostgreSQL.', kind: 'decision' });
  const memories = await listMemories(project);
  assert.equal(memories[0].id, saved.memory.id);
  assert.equal(duplicate.memory.id, saved.memory.id);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].title, 'Banco principal');
  assert.equal(memories[0].kind, 'decision');

  const global = await saveMemory({ projectPath: project, title: 'Idioma', content: 'Responder em português.', kind: 'preference', scope: 'global' });
  const session = await saveMemory({ projectPath: project, title: 'Rascunho', content: 'Decisão temporária da conversa.', scope: 'session', sessionId: 'sessao-A' });
  const sessaoA = await listMemories(project, { sessionId: 'sessao-A' });
  const sessaoB = await listMemories(project, { sessionId: 'sessao-B' });
  assert.ok(sessaoA.some((item) => item.id === global.memory.id && item.scope === 'global'));
  assert.ok(sessaoA.some((item) => item.id === session.memory.id && item.scope === 'session'));
  assert.ok(!sessaoB.some((item) => item.id === session.memory.id), 'memória de sessão não pode vazar');

  const updated = await updateMemory({ projectPath: project, id: saved.memory.id, title: 'Banco definitivo', content: 'Usar PostgreSQL 16.' });
  assert.equal(updated.memory.title, 'Banco definitivo');
  assert.equal(updated.memory.content, 'Usar PostgreSQL 16.');
  const exported = await exportMemories(project, { sessionId: 'sessao-A' });
  assert.equal(exported.version, 1);
  assert.ok(exported.memories.length >= 3);

  await deleteMemory({ projectPath: project, id: global.memory.id });
  assert.ok(!(await listMemories(project, { sessionId: 'sessao-A' })).some((item) => item.id === global.memory.id));

  await Promise.all(Array.from({ length: 12 }, (_, index) => saveMemory({
    projectPath: project,
    title: `Concorrente ${index}`,
    content: `Registro concorrente número ${index}`,
  })));
  const afterConcurrentWrites = await listMemories(project, { sessionId: 'sessao-A' });
  assert.equal(afterConcurrentWrites.filter((item) => item.title.startsWith('Concorrente')).length, 12);
  await fs.rm(project, { recursive: true, force: true });
  await fs.rm(memoryRoot, { recursive: true, force: true });
});
