const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { corpusId } = require('./workspace-indexer');

const MEMORY_ROOT = path.resolve(process.env.JARVIS_MEMORY_PATH || path.join(__dirname, '..', 'data', 'memory'));
const GLOBAL_MEMORY_FILE = '_global.json';
const ALLOWED_KINDS = new Set(['context', 'decision', 'preference', 'requirement']);
const ALLOWED_SCOPES = new Set(['global', 'project', 'session']);
const mutationQueues = new Map();

function normalizeProject(projectPath) {
  return path.resolve(String(projectPath || ''));
}

function normalizeScope(scope) {
  return ALLOWED_SCOPES.has(scope) ? scope : 'project';
}

function projectMemoryPath(projectPath) {
  return path.join(MEMORY_ROOT, `${corpusId(normalizeProject(projectPath))}.json`);
}

function scopeMemoryPath(projectPath, scope) {
  return normalizeScope(scope) === 'global'
    ? path.join(MEMORY_ROOT, GLOBAL_MEMORY_FILE)
    : projectMemoryPath(projectPath);
}

async function readMemoryFile(filePath) {
  try {
    const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeMemoryFile(filePath, memories) {
  await fs.mkdir(MEMORY_ROOT, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(memories, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

function withMutation(filePath, operation) {
  const previous = mutationQueues.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  mutationQueues.set(filePath, current);
  return current.finally(() => {
    if (mutationQueues.get(filePath) === current) mutationQueues.delete(filePath);
  });
}

function normalizeMemory(memory, fallbackScope = 'project') {
  return {
    ...memory,
    scope: normalizeScope(memory.scope || fallbackScope),
    sessionId: memory.sessionId ? String(memory.sessionId) : null,
  };
}

async function listMemories(projectPath, options = {}) {
  const requestedScope = ALLOWED_SCOPES.has(options.scope) ? options.scope : null;
  const projectFile = projectMemoryPath(projectPath);
  const globalFile = path.join(MEMORY_ROOT, GLOBAL_MEMORY_FILE);
  const sources = requestedScope === 'global'
    ? [[globalFile, 'global']]
    : requestedScope
      ? [[projectFile, 'project']]
      : [[globalFile, 'global'], [projectFile, 'project']];

  const memories = [];
  for (const [filePath, fallbackScope] of sources) {
    const records = await readMemoryFile(filePath);
    memories.push(...records.map((memory) => normalizeMemory(memory, fallbackScope)));
  }

  const query = String(options.query || '').trim().toLocaleLowerCase('pt-BR');
  const sessionId = String(options.sessionId || '');
  const filtered = memories.filter((memory) => {
    if (requestedScope && memory.scope !== requestedScope) return false;
    if (options.kind && memory.kind !== options.kind) return false;
    if (memory.scope === 'session' && memory.sessionId !== sessionId) return false;
    if (!query) return true;
    return `${memory.title}\n${memory.content}\n${memory.kind}`.toLocaleLowerCase('pt-BR').includes(query);
  }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const seen = new Set();
  return filtered.filter((memory) => {
    const signature = `${memory.scope}\u0000${memory.sessionId || ''}\u0000${memory.kind}\u0000${memory.content}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

async function saveMemory({ projectPath, title, content, kind = 'context', scope = 'project', sessionId } = {}) {
  const normalizedProject = normalizeProject(projectPath);
  const normalizedScope = normalizeScope(scope);
  const normalizedContent = String(content || '').trim().slice(0, 50_000);
  if (!normalizedContent) throw new Error('A memória não pode estar vazia.');
  if (normalizedScope === 'session' && !String(sessionId || '').trim()) {
    throw new Error('Memória de sessão exige um identificador de conversa.');
  }
  const safeTitle = String(title || 'Memória do projeto').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  const now = new Date().toISOString();
  const filePath = scopeMemoryPath(normalizedProject, normalizedScope);

  return withMutation(filePath, async () => {
    const memories = await readMemoryFile(filePath);
    const memory = {
      id: crypto.randomUUID(),
      title: safeTitle,
      content: normalizedContent,
      kind: ALLOWED_KINDS.has(kind) ? kind : 'context',
      scope: normalizedScope,
      sessionId: normalizedScope === 'session' ? String(sessionId) : null,
      createdAt: now,
      updatedAt: now,
    };
    const duplicate = memories.find((item) => (
      normalizeScope(item.scope || normalizedScope) === memory.scope
      && (item.sessionId || null) === memory.sessionId
      && item.kind === memory.kind
      && item.content === memory.content
    ));
    if (duplicate) {
      duplicate.title = safeTitle;
      duplicate.updatedAt = now;
      duplicate.scope = normalizedScope;
      duplicate.sessionId = memory.sessionId;
      await writeMemoryFile(filePath, memories.slice(-500));
      return { corpus: corpusId(normalizedProject), memory: normalizeMemory(duplicate, normalizedScope), deduplicated: true };
    }
    memories.push(memory);
    await writeMemoryFile(filePath, memories.slice(-500));
    return { corpus: corpusId(normalizedProject), memory };
  });
}

async function findAndMutateMemory({ projectPath, id, mutate }) {
  const memoryId = String(id || '').trim();
  if (!memoryId) throw new Error('Identificador de memória ausente.');
  const files = [path.join(MEMORY_ROOT, GLOBAL_MEMORY_FILE), projectMemoryPath(projectPath)];
  for (const filePath of files) {
    const result = await withMutation(filePath, async () => {
      const memories = await readMemoryFile(filePath);
      const index = memories.findIndex((item) => item.id === memoryId);
      if (index === -1) return null;
      const outcome = mutate(memories, index);
      await writeMemoryFile(filePath, memories);
      return outcome;
    });
    if (result) return result;
  }
  throw new Error('Memória não encontrada neste projeto.');
}

async function updateMemory({ projectPath, id, title, content, kind } = {}) {
  return findAndMutateMemory({
    projectPath,
    id,
    mutate(memories, index) {
      const current = memories[index];
      const nextContent = content === undefined ? current.content : String(content || '').trim().slice(0, 50_000);
      if (!nextContent) throw new Error('A memória não pode estar vazia.');
      current.title = title === undefined
        ? current.title
        : String(title || 'Memória').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
      current.content = nextContent;
      if (kind !== undefined) current.kind = ALLOWED_KINDS.has(kind) ? kind : current.kind;
      current.updatedAt = new Date().toISOString();
      return { memory: normalizeMemory(current) };
    },
  });
}

async function deleteMemory({ projectPath, id } = {}) {
  return findAndMutateMemory({
    projectPath,
    id,
    mutate(memories, index) {
      const [removed] = memories.splice(index, 1);
      return { removed: normalizeMemory(removed) };
    },
  });
}

async function exportMemories(projectPath, options = {}) {
  const memories = await listMemories(projectPath, options);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: corpusId(normalizeProject(projectPath)),
    memories,
  };
}

function formatMemoriesForPrompt(memories, limit = 20) {
  return memories.slice(0, limit).map((memory) => (
    `- [${memory.scope}/${memory.kind}] ${memory.title}: ${memory.content}`
  )).join('\n');
}

module.exports = {
  MEMORY_ROOT,
  deleteMemory,
  exportMemories,
  formatMemoriesForPrompt,
  listMemories,
  saveMemory,
  updateMemory,
};
