const fs = require('node:fs/promises');
const path = require('node:path');

const SKILLS_ROOT = path.resolve(__dirname, '..', 'skills');

// Tools com efeito operacional exigem que o modelo receba primeiro um
// procedimento especifico. O primeiro tool call apenas divulga a skill; uma
// chamada posterior, ja com as instrucoes no historico, pode executar.
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

async function listSkills() {
  let entries = [];
  try {
    entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const markdown = await fs.readFile(path.join(SKILLS_ROOT, entry.name, 'SKILL.md'), 'utf8');
      skills.push(parseSkill(markdown, entry.name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return skills;
}

async function loadSkill(id) {
  const skillId = String(id || '').trim();
  if (!skillId) return null;
  try {
    const markdown = await fs.readFile(path.join(SKILLS_ROOT, skillId, 'SKILL.md'), 'utf8');
    return parseSkill(markdown, skillId);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function requiredSkillForTool(toolName) {
  return TOOL_SKILL_REQUIREMENTS[String(toolName || '')] || null;
}

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
  SKILLS_ROOT,
  TOOL_SKILL_REQUIREMENTS,
  formatSkillsForPrompt,
  listSkills,
  loadActiveSkills,
  loadSkill,
  parseSkill,
  requiredSkillForTool,
};

