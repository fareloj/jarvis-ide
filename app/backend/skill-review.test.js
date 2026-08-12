const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSkillReview, parseModelJson } = require('./skill-review');

async function fixture(generate) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-skill-review-'));
  const skillsRoot = path.join(root, 'skills');
  const reviewRoot = path.join(root, 'reviews');
  const markdown = '---\nid: testing\nname: Testing\ndescription: Testar software\n---\n\n# Testing\n\nExecute os testes.';
  await fs.mkdir(path.join(skillsRoot, 'testing'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'testing', 'SKILL.md'), markdown);
  const reviewer = createSkillReview({
    skillsRoot,
    reviewRoot,
    generate,
    listSkills: async () => [{ id: 'testing', name: 'Testing', description: 'Testar software', content: '# Testing' }],
  });
  return { root, skillsRoot, reviewRoot, reviewer, markdown };
}

test('parser aceita JSON cercado por bloco Markdown', () => {
  assert.equal(parseModelJson('```json\n{"action":"none"}\n```').action, 'none');
});

test('revisão cria proposta mas não altera a skill sem aprovação', async (t) => {
  const proposed = '---\nid: testing\nname: Testing\ndescription: Testar software com verificação\n---\n\n# Testing\n\nExecute os testes e confirme a saída antes de concluir.';
  const env = await fixture(async () => JSON.stringify({
    action: 'update', skillId: 'testing', title: 'Adicionar verificação',
    reason: 'A conversa validou uma etapa ausente.', confidence: 0.9, proposedContent: proposed,
  }));
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const result = await env.reviewer.review({
    messages: [{ role: 'user', content: 'Rode os testes' }, { role: 'assistant', content: 'Os testes passaram' }],
    activeSkills: ['testing'], sessionId: 's1', model: 'm',
  });
  assert.equal(result.status, 'proposed');
  assert.equal(await fs.readFile(path.join(env.skillsRoot, 'testing', 'SKILL.md'), 'utf8'), env.markdown);
  assert.equal((await env.reviewer.listProposals('pending')).length, 1);
});

test('aprovação aplica a revisão e mantém backup do conteúdo anterior', async (t) => {
  const proposed = '---\nid: testing\nname: Testing\ndescription: Testar software com verificação\n---\n\n# Testing\n\nExecute os testes e confirme a saída antes de concluir.';
  const env = await fixture(async () => JSON.stringify({
    action: 'update', skillId: 'testing', reason: 'Procedimento validado.', confidence: 0.9, proposedContent: proposed,
  }));
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const reviewed = await env.reviewer.review({
    messages: [{ role: 'user', content: 'Teste' }, { role: 'assistant', content: 'Validado' }], activeSkills: ['testing'],
  });
  await env.reviewer.resolve(reviewed.proposal.id, true);
  assert.match(await fs.readFile(path.join(env.skillsRoot, 'testing', 'SKILL.md'), 'utf8'), /confirme a saída/);
  assert.equal(await fs.readFile(path.join(env.reviewRoot, 'backups', reviewed.proposal.id, 'SKILL.md'), 'utf8'), env.markdown);
});

test('aprovação recusa sobrescrever uma skill alterada depois da proposta', async (t) => {
  const proposed = '---\nid: testing\nname: Testing\ndescription: Testar software com verificação\n---\n\n# Testing\n\nExecute os testes e confirme a saída antes de concluir.';
  const env = await fixture(async () => JSON.stringify({
    action: 'update', skillId: 'testing', reason: 'Procedimento validado.', confidence: 0.9, proposedContent: proposed,
  }));
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const reviewed = await env.reviewer.review({
    messages: [{ role: 'user', content: 'Teste' }, { role: 'assistant', content: 'Validado' }], activeSkills: ['testing'],
  });
  await fs.writeFile(path.join(env.skillsRoot, 'testing', 'SKILL.md'), `${env.markdown}\n\nAlteração posterior.`);
  await assert.rejects(
    env.reviewer.resolve(reviewed.proposal.id, true),
    /mudou depois da proposta/,
  );
});

test('uso de skills acumula frequência e data da última utilização', async (t) => {
  const env = await fixture(async () => '{"action":"none"}');
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const first = await env.reviewer.recordUsage(['testing']);
  const second = await env.reviewer.recordUsage(['testing', 'testing']);
  assert.equal(first.testing.count, 1);
  assert.equal(second.testing.count, 2);
  assert.ok(second.testing.lastUsedAt);
});
