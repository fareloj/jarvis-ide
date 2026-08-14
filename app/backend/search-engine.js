// Motor de busca e substituição global para o workspace.
//
// Realiza busca textual/regex em arquivos do projeto com filtro de arquivos
// ignorados (binários, .git, node_modules), e substituição transacional
// multi-arquivo utilizando planPatch/applyPatch de backend/file-write.js.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { planPatch, applyPatch } = require('./file-write');

const MAX_SEARCH_RESULTS = 1000;
const MAX_SEARCH_FILE_BYTES = 1_500_000; // 1.5 MB por arquivo individual
const PLAN_TTL_MS = 5 * 60_000;
const pendingReplacePlans = new Map();

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Busca cancelada.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.gemini',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'bin',
  'obj',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.svelte-kit',
]);

const IGNORED_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.img',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.mp4', '.mkv', '.avi', '.mov', '.mp3', '.wav', '.flac', '.ogg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pyc', '.pyo', '.pyd', '.class', '.jar', '.war', '.lock',
]);

function isSearchableFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return !IGNORED_EXTENSIONS.has(ext);
}

function matchPattern(filePath, pattern) {
  if (!pattern || pattern.trim() === '' || pattern.trim() === '*') return true;
  const normalized = filePath.replace(/\\/g, '/');
  const patterns = pattern.split(',').map((p) => p.trim()).filter(Boolean);
  return patterns.some((pat) => {
    let glob = pat.replace(/\\/g, '/');
    if (glob.startsWith('*.')) {
      const ext = glob.slice(1);
      return normalized.endsWith(ext);
    }
    // Suporte a glob simples com placeholder para **
    const regexStr = '^' + glob
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '§DOUBLESTAR§')
      .replace(/\*/g, '[^/]*')
      .replace(/§DOUBLESTAR§/g, '.*') + '$';
    try {
      return new RegExp(regexStr, 'i').test(normalized) || new RegExp(regexStr, 'i').test(path.basename(normalized));
    } catch {
      return normalized.includes(glob);
    }
  });
}

function buildSearchRegex(query, { isRegex = false, isCaseSensitive = false, isWholeWord = false } = {}) {
  let pattern = query;
  if (!isRegex) {
    pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (isWholeWord) {
    pattern = `\\b(?:${pattern})\\b`;
  }
  const flags = isCaseSensitive ? 'g' : 'gi';
  return new RegExp(pattern, flags);
}

async function collectFiles(dirPath, rootPath, filesList = [], signal = null) {
  throwIfAborted(signal);
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return filesList;
  }

  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
        await collectFiles(path.join(dirPath, entry.name), rootPath, filesList, signal);
      }
    } else if (entry.isFile()) {
      if (isSearchableFile(entry.name)) {
        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
        filesList.push({ fullPath, relPath });
      }
    }
  }
  return filesList;
}

async function searchProjectText({
  projectPath,
  query,
  isRegex = false,
  isCaseSensitive = false,
  isWholeWord = false,
  filePattern = '',
  maxResults = MAX_SEARCH_RESULTS,
} = {}, { signal = null } = {}) {
  throwIfAborted(signal);
  const raiz = path.resolve(String(projectPath || ''));
  if (!raiz || raiz === '.') throw new Error('Nenhum projeto aberto para busca.');
  const termo = String(query || '');
  if (!termo) {
    return { query: '', results: [], totalMatches: 0, fileCount: 0, truncated: false };
  }

  let regex;
  try {
    regex = buildSearchRegex(termo, { isRegex, isCaseSensitive, isWholeWord });
  } catch (err) {
    throw new Error(`Expressão regular inválida: ${err.message}`);
  }

  const allFiles = await collectFiles(raiz, raiz, [], signal);
  const matchedFiles = allFiles.filter((f) => matchPattern(f.relPath, filePattern));

  const results = [];
  let totalMatches = 0;
  let truncated = false;
  const filesWithMatches = new Set();

  for (const file of matchedFiles) {
    throwIfAborted(signal);
    if (totalMatches >= maxResults) {
      truncated = true;
      break;
    }

    try {
      const stat = await fs.stat(file.fullPath);
      if (stat.size > MAX_SEARCH_FILE_BYTES) continue;

      const content = await fs.readFile(file.fullPath, 'utf8');
      // Ignora arquivos binários com caracteres nulos
      if (content.includes('\0')) continue;

      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        throwIfAborted(signal);
        const lineContent = lines[lineIndex];
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(lineContent)) !== null) {
          totalMatches += 1;
          filesWithMatches.add(file.relPath);

          results.push({
            path: file.relPath,
            line: lineIndex + 1,
            column: match.index + 1,
            matchLength: match[0].length || 1,
            matchText: match[0],
            lineContent: lineContent.slice(0, 1000), // limita comprimento de linha
          });

          if (totalMatches >= maxResults) {
            truncated = true;
            break;
          }
          if (match[0].length === 0) {
            regex.lastIndex += 1;
          }
        }
        if (totalMatches >= maxResults) break;
      }
    } catch {
      // Ignora erros de leitura de arquivo individual
    }
  }

  return {
    query: termo,
    results,
    totalMatches,
    fileCount: filesWithMatches.size,
    truncated,
  };
}

async function planSearchReplace({
  projectPath,
  query,
  replacement = '',
  isRegex = false,
  isCaseSensitive = false,
  isWholeWord = false,
  filePattern = '',
  selectedFiles = null,
  ownerId = 'local',
} = {}) {
  const raiz = path.resolve(String(projectPath || ''));
  if (!raiz || raiz === '.') throw new Error('Nenhum projeto aberto para substituição.');
  const termo = String(query || '');
  if (!termo) throw new Error('Informe o termo de busca para substituir.');

  let regex;
  try {
    regex = buildSearchRegex(termo, { isRegex, isCaseSensitive, isWholeWord });
  } catch (err) {
    throw new Error(`Expressão regular inválida: ${err.message}`);
  }

  const allFiles = await collectFiles(raiz, raiz);
  const matchedFiles = allFiles.filter((f) => {
    if (!matchPattern(f.relPath, filePattern)) return false;
    if (Array.isArray(selectedFiles) && selectedFiles.length) {
      return selectedFiles.includes(f.relPath);
    }
    return true;
  });

  const filesToPatch = [];
  let totalMatches = 0;

  for (const file of matchedFiles) {
    try {
      const stat = await fs.stat(file.fullPath);
      if (stat.size > MAX_SEARCH_FILE_BYTES) continue;

      const content = await fs.readFile(file.fullPath, 'utf8');
      if (content.includes('\0')) continue;

      regex.lastIndex = 0;
      let countInFile = 0;
      const newContent = content.replace(regex, (...args) => {
        countInFile += 1;
        if (isRegex) {
          // Permite referências $1, $2 no replacement
          return replacement.replace(/\$(\d+)/g, (_, n) => args[Number(n)] || '');
        }
        return replacement;
      });

      if (countInFile > 0 && newContent !== content) {
        totalMatches += countInFile;
        filesToPatch.push({
          path: file.relPath,
          content: newContent,
        });
      }
    } catch {
      // Ignora falha de leitura em arquivo individual
    }
  }

  if (!filesToPatch.length) {
    return {
      planId: null,
      diff: '',
      resumo: [],
      totalMatches: 0,
      fileCount: 0,
    };
  }

  const patchPlan = await planPatch({
    projectPath: raiz,
    files: filesToPatch,
  });

  const planId = crypto.randomUUID();
  const expiresAt = Date.now() + PLAN_TTL_MS;
  pendingReplacePlans.set(planId, {
    ownerId: String(ownerId),
    plans: patchPlan.planos,
    expiresAt,
  });

  return {
    planId,
    diff: patchPlan.diff,
    resumo: patchPlan.resumo,
    totalMatches,
    fileCount: filesToPatch.length,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

async function applySearchReplace({ planId, ownerId = 'local' } = {}) {
  if (typeof planId !== 'string' || !/^[0-9a-f-]{36}$/i.test(planId)) {
    throw new Error('Plano de substituição inválido.');
  }
  const pending = pendingReplacePlans.get(planId);
  if (!pending) throw new Error('Plano de substituição inexistente ou já utilizado.');
  if (pending.expiresAt < Date.now()) {
    pendingReplacePlans.delete(planId);
    throw new Error('Plano de substituição expirado.');
  }
  if (pending.ownerId !== String(ownerId)) throw new Error('Plano de substituição pertence a outro contexto.');
  pendingReplacePlans.delete(planId);
  return applyPatch(pending.plans);
}

module.exports = {
  searchProjectText,
  planSearchReplace,
  applySearchReplace,
  matchPattern,
  buildSearchRegex,
  isSearchableFile,
  IGNORED_DIRECTORIES,
  IGNORED_EXTENSIONS,
  throwIfAborted,
};
