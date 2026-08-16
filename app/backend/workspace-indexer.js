const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const STAGING_ROOT = path.resolve(
  process.env.JARVIS_RAG_STAGING_PATH || path.join(__dirname, '..', 'data', 'rag-workspace'),
);
const NOTES_ROOT = path.resolve(process.env.JARVIS_RAG_NOTES_PATH || path.join(__dirname, '..', 'data', 'notes'));
const MANIFEST_ROOT = path.resolve(
  process.env.JARVIS_RAG_MANIFEST_PATH || path.join(__dirname, '..', 'data', 'rag-manifests'),
);
const APP_RUNTIME_ROOT = path.resolve(__dirname, '..', 'data');
const ALLOWED_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsx', '.kt', '.md', '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.sql', '.svelte', '.toml', '.ts',
  '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.agents', '.claude', '.codex', '.git', '.gradle', '.idea', '.next', '.nuxt', '.turbo', '.venv', '.vscode', 'build', 'coverage', 'dist',
  'node_modules', 'target', 'vendor', 'venv',
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 150_000_000;

function corpusId(projectPath) {
  const name = path.basename(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  const hash = crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 10);
  return `${name}-${hash}`;
}

function assertInsideStaging(target) {
  const relative = path.relative(STAGING_ROOT, path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Destino fora do staging do JARVIS.');
}

async function collectFiles(root) {
  const files = [];
  let totalBytes = 0;

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (absolute === APP_RUNTIME_ROOT || absolute.startsWith(`${APP_RUNTIME_ROOT}${path.sep}`)
        || absolute === STAGING_ROOT || absolute.startsWith(`${STAGING_ROOT}${path.sep}`)
        || absolute === NOTES_ROOT || absolute.startsWith(`${NOTES_ROOT}${path.sep}`)) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_FILE_BYTES) continue;
      totalBytes += stat.size;
      if (files.length >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error('O projeto excede o limite de indexação do JARVIS.');
      }
      const content = await fs.readFile(absolute);
      files.push({
        absolute,
        relative: path.relative(root, absolute),
        size: stat.size,
        hash: crypto.createHash('sha256').update(content).digest('hex'),
      });
    }
  }

  await walk(root);
  return { files, totalBytes };
}

async function stageProject(projectPath) {
  const source = path.resolve(String(projectPath || ''));
  const sourceStat = await fs.stat(source);
  if (!sourceStat.isDirectory()) throw new Error('O projeto selecionado não é uma pasta.');
  const id = corpusId(source);
  const destination = path.join(STAGING_ROOT, id);
  assertInsideStaging(destination);
  await fs.mkdir(destination, { recursive: true });

  try {
    const { files, totalBytes } = await collectFiles(source);
    const manifestPath = path.join(MANIFEST_ROOT, `${id}.json`);
    let previousManifest = { files: {} };
    try {
      previousManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const nextFiles = Object.fromEntries(files.map((file) => [file.relative.replaceAll('\\', '/'), {
      hash: file.hash,
      size: file.size,
    }]));
    const changed = [];
    const unchanged = [];
    for (const file of files) {
      const target = path.join(destination, file.relative);
      assertInsideStaging(target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const key = file.relative.replaceAll('\\', '/');
      if (previousManifest.files?.[key]?.hash === file.hash) {
        try {
          await fs.access(target);
          unchanged.push(key);
          continue;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const temporaryFile = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.copyFile(file.absolute, temporaryFile);
      await fs.rename(temporaryFile, target);
      changed.push(key);
    }
    const persistedNotes = path.join(NOTES_ROOT, id);
    try {
      await fs.cp(persistedNotes, path.join(destination, 'notes'), { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(MANIFEST_ROOT, { recursive: true });
    const deleted = Object.keys(previousManifest.files || {}).filter((file) => !nextFiles[file]);
    for (const relative of deleted) {
      const target = path.join(destination, relative);
      assertInsideStaging(target);
      await fs.rm(target, { force: true });
    }
    const manifest = {
      version: 1,
      corpus: id,
      projectPath: source,
      updatedAt: new Date().toISOString(),
      files: nextFiles,
    };
    const manifestTemporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(manifestTemporary, JSON.stringify(manifest, null, 2), 'utf8');
    await fs.rename(manifestTemporary, manifestPath);
    return {
      corpus: id,
      containerPath: `/jarvis-workspace/${id}`,
      hostPath: destination,
      fileCount: files.length,
      totalBytes,
      changed,
      unchanged,
      deleted,
      incremental: true,
      indexedAt: manifest.updatedAt,
    };
  } catch (error) {
    throw error;
  }
}

async function saveNote({ projectPath, title, content, noteId: requestedNoteId } = {}) {
  const normalizedContent = String(content || '').trim();
  if (!normalizedContent) throw new Error('A nota não pode estar vazia.');
  const id = corpusId(path.resolve(String(projectPath || '')));
  const notesDir = path.join(NOTES_ROOT, id);
  const stagedNotesDir = path.join(STAGING_ROOT, id, 'notes');
  assertInsideStaging(stagedNotesDir);
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(stagedNotesDir, { recursive: true });
  const noteId = String(requestedNoteId || `note-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(noteId)) throw new Error('Identificador de nota invÃ¡lido.');
  const notePath = path.join(notesDir, `${noteId}.md`);
  const stagedNotePath = path.join(stagedNotesDir, `${noteId}.md`);
  const safeTitle = String(title || 'Nota do JARVIS').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const markdown = `# ${safeTitle}\n\n${normalizedContent.slice(0, 100_000)}\n`;
  await fs.writeFile(notePath, markdown, 'utf8');
  await fs.writeFile(stagedNotePath, markdown, 'utf8');
  return { corpus: id, noteId, path: notePath, containerPath: `/jarvis-workspace/${id}` };
}

async function deleteNote({ projectPath, noteId } = {}) {
  const id = corpusId(path.resolve(String(projectPath || '')));
  const normalizedId = String(noteId || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(normalizedId)) throw new Error('Identificador de nota invÃ¡lido.');
  const notePath = path.join(NOTES_ROOT, id, `${normalizedId}.md`);
  const stagedNotePath = path.join(STAGING_ROOT, id, 'notes', `${normalizedId}.md`);
  await Promise.all([
    fs.rm(notePath, { force: true }),
    fs.rm(stagedNotePath, { force: true }),
  ]);
  return { corpus: id, noteId: normalizedId, deleted: true };
}

async function listCorpusDocuments({ corpus, projectPath } = {}) {
  const id = String(corpus || (projectPath ? corpusId(path.resolve(projectPath)) : '')).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,160}$/.test(id)) throw new Error('Corpus inválido.');
  const root = path.join(STAGING_ROOT, id);
  assertInsideStaging(root);
  const documents = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        const relative = path.relative(root, absolute).replaceAll('\\', '/');
        documents.push({
          path: relative,
          size: stat.size,
          extension: path.extname(entry.name).slice(1).toLowerCase() || 'text',
          source: relative.startsWith('notes/') ? 'memory' : 'project',
        });
      }
    }
  }

  try {
    await walk(root);
  } catch (error) {
    if (error.code === 'ENOENT') return { corpus: id, documents: [], totalBytes: 0 };
    throw error;
  }
  documents.sort((left, right) => left.path.localeCompare(right.path));
  return { corpus: id, documents, totalBytes: documents.reduce((sum, item) => sum + item.size, 0) };
}

module.exports = {
  STAGING_ROOT,
  corpusId,
  deleteNote,
  listCorpusDocuments,
  saveNote,
  stageProject,
};
