const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const rag = require('./rag-client');
const { listMemories, saveMemory } = require('./memory-store');

const execFileAsync = promisify(execFile);
const pendingApprovals = new Map();

const DEFINITIONS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'rag_search',
      description: 'Pesquisa evidências no corpus RAG do projeto aberto.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'integer' } }, required: ['query'] },
    },
    policy: { risk: 'read', approval: 'never' },
  },
  {
    type: 'function',
    function: {
      name: 'project_list_files',
      description: 'Lista arquivos de texto dentro do projeto aberto.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    policy: { risk: 'read', approval: 'never' },
  },
  {
    type: 'function',
    function: {
      name: 'project_read_file',
      description: 'Lê um arquivo de texto dentro do projeto aberto.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    policy: { risk: 'read', approval: 'never' },
  },
  {
    type: 'function',
    function: {
      name: 'memory_list',
      description: 'Lista memórias persistentes do projeto.',
      parameters: { type: 'object', properties: {} },
    },
    policy: { risk: 'read', approval: 'never' },
  },
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: 'Salva uma decisão, requisito, preferência ou contexto na memória persistente.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' }, content: { type: 'string' },
          kind: { type: 'string', enum: ['context', 'decision', 'preference', 'requirement'] },
        },
        required: ['title', 'content'],
      },
    },
    policy: { risk: 'write', approval: 'always' },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_run',
      description: 'Executa um comando PowerShell no projeto aberto.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
    policy: { risk: 'execute', approval: 'always' },
  },
]);

function publicDefinitions() {
  return DEFINITIONS.map(({ policy, ...definition }) => definition);
}

function describeTools() {
  return DEFINITIONS.map(({ function: fn, policy }) => ({ name: fn.name, description: fn.description, ...policy }));
}

function toolDefinition(name) {
  return DEFINITIONS.find((definition) => definition.function.name === name);
}

function resolveProjectTarget(projectPath, relativePath = '.') {
  const root = path.resolve(String(projectPath || ''));
  const target = path.resolve(root, String(relativePath || '.'));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('A tool tentou acessar fora do projeto aberto.');
  return { root, target, relative };
}

async function listProjectFiles(projectPath, relativePath) {
  const { root, target } = resolveProjectTarget(projectPath, relativePath);
  const output = [];
  const skipped = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (output.length >= 300) return;
      if (entry.isSymbolicLink() || (entry.isDirectory() && skipped.has(entry.name))) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) output.push(path.relative(root, absolute));
    }
  }
  await walk(target);
  return output;
}

async function runTool(name, args = {}, context = {}) {
  const projectPath = context.projectPath;
  if (name === 'rag_search') {
    return rag.search({ query: args.query, topK: args.top_k || 6, useReranker: false, filters: context.corpus ? { corpus: context.corpus } : {} });
  }
  if (name === 'project_list_files') return { files: await listProjectFiles(projectPath, args.path) };
  if (name === 'project_read_file') {
    const { target, relative } = resolveProjectTarget(projectPath, args.path);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 500_000) throw new Error('O arquivo não é textual ou excede 500 KB.');
    return { path: relative, content: await fs.readFile(target, 'utf8') };
  }
  if (name === 'memory_list') return { memories: await listMemories(projectPath) };
  if (name === 'memory_save') return saveMemory({ projectPath, ...args });
  if (name === 'terminal_run') {
    const command = String(args.command || '').trim().slice(0, 8_000);
    if (!command) throw new Error('Comando vazio.');
    const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: path.resolve(projectPath), timeout: 60_000, maxBuffer: 1_000_000, windowsHide: true,
    });
    return { stdout, stderr, exitCode: 0 };
  }
  throw new Error(`Tool desconhecida: ${name}`);
}

async function requestTool(name, args, context) {
  const definition = toolDefinition(name);
  if (!definition) throw new Error(`Tool desconhecida: ${name}`);
  if (definition.policy.approval === 'never') return { status: 'completed', result: await runTool(name, args, context) };
  const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  pendingApprovals.set(id, { id, name, args, context, createdAt: Date.now() });
  setTimeout(() => pendingApprovals.delete(id), 10 * 60_000).unref?.();
  return { status: 'approval_required', approval: { id, name, args, risk: definition.policy.risk } };
}

async function resolveApproval(id, approved) {
  const pending = pendingApprovals.get(String(id || ''));
  if (!pending) throw new Error('Aprovação inexistente ou expirada.');
  pendingApprovals.delete(pending.id);
  if (!approved) return { status: 'denied', name: pending.name };
  return { status: 'completed', name: pending.name, result: await runTool(pending.name, pending.args, pending.context) };
}

module.exports = { describeTools, publicDefinitions, requestTool, resolveApproval, resolveProjectTarget, runTool };

