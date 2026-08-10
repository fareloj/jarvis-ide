const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const STAGING_ROOT = path.resolve(
  process.env.JARVIS_RAG_STAGING_PATH || path.join(__dirname, '..', 'data', 'rag-workspace'),
);
const NOTES_ROOT = path.resolve(__dirname, '..', 'data', 'notes');
const ALLOWED_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsx', '.kt', '.md', '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.sql', '.svelte', '.toml', '.ts',
  '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.idea', '.next', '.nuxt', '.turbo', '.venv', '.vscode', 'build', 'coverage', 'dist',
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
      if (absolute === STAGING_ROOT || absolute.startsWith(`${STAGING_ROOT}${path.sep}`)
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
      files.push({ absolute, relative: path.relative(root, absolute), size: stat.size });
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
  const temporary = path.join(STAGING_ROOT, `.staging-${id}-${Date.now()}`);
  assertInsideStaging(destination);
  assertInsideStaging(temporary);
  await fs.mkdir(temporary, { recursive: true });

  try {
    const { files, totalBytes } = await collectFiles(source);
    for (const file of files) {
      const target = path.join(temporary, file.relative);
      assertInsideStaging(target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file.absolute, target);
    }
    const persistedNotes = path.join(NOTES_ROOT, id);
    try {
      await fs.cp(persistedNotes, path.join(temporary, 'notes'), { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(temporary, destination);
    return {
      corpus: id,
      containerPath: `/jarvis-workspace/${id}`,
      hostPath: destination,
      fileCount: files.length,
      totalBytes,
    };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function saveNote({ projectPath, title, content } = {}) {
  const normalizedContent = String(content || '').trim();
  if (!normalizedContent) throw new Error('A nota não pode estar vazia.');
  const id = corpusId(path.resolve(String(projectPath || '')));
  const notesDir = path.join(NOTES_ROOT, id);
  const stagedNotesDir = path.join(STAGING_ROOT, id, 'notes');
  assertInsideStaging(stagedNotesDir);
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(stagedNotesDir, { recursive: true });
  const noteId = `note-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const notePath = path.join(notesDir, `${noteId}.md`);
  const stagedNotePath = path.join(stagedNotesDir, `${noteId}.md`);
  const safeTitle = String(title || 'Nota do JARVIS').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const markdown = `# ${safeTitle}\n\n${normalizedContent.slice(0, 100_000)}\n`;
  await fs.writeFile(notePath, markdown, 'utf8');
  await fs.writeFile(stagedNotePath, markdown, 'utf8');
  return { corpus: id, noteId, path: notePath, containerPath: `/jarvis-workspace/${id}` };
}

module.exports = { STAGING_ROOT, corpusId, saveNote, stageProject };
