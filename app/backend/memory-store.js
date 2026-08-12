const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { corpusId } = require('./workspace-indexer');

const MEMORY_ROOT = path.resolve(process.env.JARVIS_MEMORY_PATH || path.join(__dirname, '..', 'data', 'memory'));

function projectMemoryPath(projectPath) {
  return path.join(MEMORY_ROOT, `${corpusId(path.resolve(String(projectPath || '')))}.json`);
}

async function readMemories(projectPath) {
  try {
    const payload = JSON.parse(await fs.readFile(projectMemoryPath(projectPath), 'utf8'));
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeMemories(projectPath, memories) {
  await fs.mkdir(MEMORY_ROOT, { recursive: true });
  const destination = projectMemoryPath(projectPath);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(memories, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, destination);
}

async function listMemories(projectPath) {
  const sorted = (await readMemories(projectPath)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const seen = new Set();
  return sorted.filter((memory) => {
    const signature = `${memory.kind}\u0000${memory.content}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

async function saveMemory({ projectPath, title, content, kind = 'context' } = {}) {
  const normalizedProject = path.resolve(String(projectPath || ''));
  const normalizedContent = String(content || '').trim().slice(0, 50_000);
  if (!normalizedContent) throw new Error('A memória não pode estar vazia.');
  const safeTitle = String(title || 'Memória do projeto').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  const allowedKinds = new Set(['context', 'decision', 'preference', 'requirement']);
  const now = new Date().toISOString();
  const memory = {
    id: crypto.randomUUID(),
    title: safeTitle,
    content: normalizedContent,
    kind: allowedKinds.has(kind) ? kind : 'context',
    createdAt: now,
    updatedAt: now,
  };
  const memories = await readMemories(normalizedProject);
  const duplicate = memories.find((item) => item.kind === memory.kind && item.content === memory.content);
  if (duplicate) {
    duplicate.title = safeTitle;
    duplicate.updatedAt = now;
    await writeMemories(normalizedProject, memories.slice(-500));
    return { corpus: corpusId(normalizedProject), memory: duplicate, deduplicated: true };
  }
  memories.push(memory);
  await writeMemories(normalizedProject, memories.slice(-500));
  return { corpus: corpusId(normalizedProject), memory };
}

function formatMemoriesForPrompt(memories, limit = 20) {
  return memories.slice(0, limit).map((memory) => (
    `- [${memory.kind}] ${memory.title}: ${memory.content}`
  )).join('\n');
}

module.exports = { MEMORY_ROOT, formatMemoriesForPrompt, listMemories, saveMemory };
