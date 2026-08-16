const fs = require('node:fs/promises');
const path = require('node:path');

const SKILLS_ROOT = path.resolve(__dirname, '..', 'skills');
const REVIEW_ROOT = path.resolve(process.env.JARVIS_SKILL_REVIEW_PATH || path.join(__dirname, '..', 'data', 'skill-reviews'));
const ALLOWED_RESOURCE_ROOTS = new Set(['references', 'templates', 'scripts', 'assets']);
const MAX_RESOURCE_FILES = 200;
const MAX_TEXT_RESOURCE_BYTES = 500_000;
const MAX_ASSET_BYTES = 10_000_000;

const TOOL_SKILL_REQUIREMENTS = Object.freeze({
  terminal_run: 'terminal-ops',
  delegate_coding_task: 'delegate-coding-agent',
  continue_coding_task: 'continue-coding-agent',
  review_coding_changes: 'review-with-coding-agent',
  inspect_coding_agent: 'inspect-coding-agent',
  background_job_status: 'control-background-job',
  cancel_background_job: 'control-background-job',
});

function parseSkill(markdown, directoryName) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const metadata = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator > 0) metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return {
    id: metadata.id || directoryName,
    name: metadata.name || directoryName,
    description: metadata.description || '',
    content: (match ? match[2] : markdown).trim(),
  };
}

async function lifecycleStates() {
  try { return JSON.parse(await fs.readFile(path.join(REVIEW_ROOT, 'usage.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function safeSkillDirectory(id) {
  const normalized = String(id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(normalized)) throw new Error('Identificador de skill inválido.');
  const directory = path.resolve(SKILLS_ROOT, normalized);
  if (path.dirname(directory) !== SKILLS_ROOT) throw new Error('Skill fora do catálogo permitido.');
  return directory;
}

async function listResources(skillId) {
  const root = safeSkillDirectory(skillId);
  const resources = [];
  async function walk(current, category) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || resources.length >= MAX_RESOURCE_FILES) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, category);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        resources.push({ category, path: path.relative(root, absolute).replaceAll('\\', '/'), size: stat.size });
      }
    }
  }
  for (const category of ALLOWED_RESOURCE_ROOTS) await walk(path.join(root, category), category);
  return resources;
}

async function listSkills({ includeArchived = false } = {}) {
  let entries = [];
  try { entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const states = await lifecycleStates();
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!includeArchived && states[entry.name]?.state === 'archived') continue;
    try {
      const markdown = await fs.readFile(path.join(SKILLS_ROOT, entry.name, 'SKILL.md'), 'utf8');
      skills.push({ ...parseSkill(markdown, entry.name), resources: await listResources(entry.name) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return skills;
}

async function loadSkill(id, { includeArchived = false } = {}) {
  const skillId = String(id || '').trim();
  if (!skillId) return null;
  const states = await lifecycleStates();
  if (!includeArchived && states[skillId]?.state === 'archived') return null;
  try {
    const markdown = await fs.readFile(path.join(safeSkillDirectory(skillId), 'SKILL.md'), 'utf8');
    return { ...parseSkill(markdown, skillId), resources: await listResources(skillId) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readSkillResource(id, resourcePath) {
  const root = safeSkillDirectory(id);
  const relative = String(resourcePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const [category] = relative.split('/');
  if (!ALLOWED_RESOURCE_ROOTS.has(category)) throw new Error('Recurso fora das pastas permitidas.');
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Recurso fora da skill.');
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('O recurso solicitado não é um arquivo.');
  const max = category === 'assets' ? MAX_ASSET_BYTES : MAX_TEXT_RESOURCE_BYTES;
  if (stat.size > max) throw new Error(`O recurso excede o limite de ${max} bytes.`);
  if (category === 'assets') return { path: relative, category, size: stat.size, encoding: 'base64', content: (await fs.readFile(target)).toString('base64') };
  return { path: relative, category, size: stat.size, encoding: 'utf8', content: await fs.readFile(target, 'utf8') };
}

function requiredSkillForTool(toolName) { return TOOL_SKILL_REQUIREMENTS[String(toolName || '')] || null; }

async function loadActiveSkills(ids = []) {
  const selected = new Set(Array.isArray(ids) ? ids.map(String) : []);
  return (await listSkills()).filter((skill) => selected.has(skill.id));
}

function formatSkillsForPrompt(skills) {
  if (!skills.length) return '';
  return `Skills ativas (siga estas instruções quando forem relevantes):\n\n${skills.map((skill) => (
    `## ${skill.name}\n${skill.content}`
  )).join('\n\n')}`;
}

module.exports = {
  ALLOWED_RESOURCE_ROOTS, SKILLS_ROOT, TOOL_SKILL_REQUIREMENTS, formatSkillsForPrompt,
  listResources, listSkills, loadActiveSkills, loadSkill, parseSkill, readSkillResource,
  requiredSkillForTool,
};
