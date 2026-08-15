const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TOOL_SKILL_REQUIREMENTS, loadSkill, parseSkill, requiredSkillForTool,
} = require('./skill-loader');

test('mapeia tools operacionais para skills obrigatorias', () => {
  assert.equal(requiredSkillForTool('delegate_coding_task'), 'delegate-coding-agent');
  assert.equal(requiredSkillForTool('continue_coding_task'), 'continue-coding-agent');
  assert.equal(requiredSkillForTool('rag_search'), null);
});

test('carrega uma skill obrigatoria pelo id', async () => {
  const skill = await loadSkill('delegate-coding-agent');
  assert.equal(skill.id, 'delegate-coding-agent');
  assert.match(skill.name, /delegate/i);
});

test('todas as tools mapeadas possuem uma skill completa no disco', async () => {
  for (const skillId of new Set(Object.values(TOOL_SKILL_REQUIREMENTS))) {
    const skill = await loadSkill(skillId);
    assert.ok(skill, `skill ausente: ${skillId}`);
    assert.ok(skill.description.length >= 40, `descricao curta: ${skillId}`);
    assert.ok(skill.content.length >= 300, `procedimento curto: ${skillId}`);
    assert.doesNotMatch(skill.content, /TODO|FIXME|placeholder/i);
  }
});

test('parser usa o nome da pasta como id quando o frontmatter nao declara id', () => {
  const skill = parseSkill('---\nname: Exemplo\ndescription: Teste\n---\nProcedimento.', 'exemplo');
  assert.equal(skill.id, 'exemplo');
  assert.equal(skill.content, 'Procedimento.');
});
