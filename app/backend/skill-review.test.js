const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  calculateReviewEvidence, createSkillReview, createUnifiedDiff, parseModelJson,
} = require('./skill-review');

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
  await env.reviewer.setSkillPolicy('testing', { adopt: true });
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
  await env.reviewer.setSkillPolicy('testing', { adopt: true });
  await fs.writeFile(path.join(env.skillsRoot, 'testing', 'SKILL.md'), `${env.markdown}\n\nAlteração posterior.`);
  await assert.rejects(
    env.reviewer.resolve(reviewed.proposal.id, true),
    /mudou depois da proposta/,
  );
});

test('aprovação concorrente aplica uma proposta uma única vez', async (t) => {
  const proposed = '---\nid: testing\nname: Testing\ndescription: Testar software com segurança\n---\n\n# Testing\n\nExecute e valide os testes antes de concluir.';
  const env = await fixture(async () => JSON.stringify({
    action: 'update', skillId: 'testing', reason: 'Procedimento validado.', confidence: 0.9, proposedContent: proposed,
  }));
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const reviewed = await env.reviewer.review({
    messages: [{ role: 'user', content: 'Teste' }, { role: 'assistant', content: 'Validado' }], activeSkills: ['testing'],
  });
  await env.reviewer.setSkillPolicy('testing', { adopt: true });
  const outcomes = await Promise.allSettled([
    env.reviewer.resolve(reviewed.proposal.id, true),
    env.reviewer.resolve(reviewed.proposal.id, true),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find((result) => result.status === 'rejected').reason.message, /já foi resolvida/);
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

test('gatilho automático exige evidência procedural, não quantidade fixa de respostas', () => {
  const casual = calculateReviewEvidence({
    messages: [{ role: 'user', content: 'Oi' }, { role: 'assistant', content: 'Olá!' }],
    evidence: {},
  });
  const corrected = calculateReviewEvidence({
    messages: [{ role: 'user', content: 'Não, está errado; deveria validar o resultado.' }, { role: 'assistant', content: 'Corrigido e testado.' }],
    evidence: {},
  });
  assert.equal(casual.eligible, false);
  assert.equal(corrected.eligible, true);
  assert.match(corrected.signals.join(' '), /correção/);
});

test('proposta inclui diff unificado legível', () => {
  const diff = createUnifiedDiff('linha 1\nlinha antiga\nlinha 3', 'linha 1\nlinha nova\nlinha 3', 'testing/SKILL.md');
  assert.match(diff, /--- a\/testing\/SKILL\.md/);
  assert.match(diff, /-linha antiga/);
  assert.match(diff, /\+linha nova/);
});

test('telemetria serializa atualizações concorrentes sem perder contagens', async (t) => {
  const env = await fixture(async () => '{"action":"none"}');
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 20 }, () => env.reviewer.recordUsage({ skillIds: ['testing'], event: 'loaded' })));
  const states = await env.reviewer.listSkillStates();
  assert.equal(states.testing.loadedCount, 20);
});

test('curador só arquiva skills gerenciadas e nunca remove seus arquivos', async (t) => {
  const env = await fixture(async () => '{"action":"none"}');
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await env.reviewer.setSkillPolicy('testing', { adopt: true });
  await env.reviewer.recordUsage({ skillIds: ['testing'], event: 'used' });
  const future = new Date(Date.now() + (100 * 86_400_000));
  const preview = await env.reviewer.curate({ now: future, apply: false });
  assert.deepEqual(preview.changes.map((change) => change.to), ['archived']);
  await env.reviewer.curate({ now: future, apply: true });
  assert.equal((await env.reviewer.listSkillStates()).testing.state, 'archived');
  assert.ok(await fs.readFile(path.join(env.skillsRoot, 'testing', 'SKILL.md'), 'utf8'));
});

test('curador recusa alterar uma skill do usuário antes da adoção explícita', async (t) => {
  const proposed = '---\nid: testing\nname: Testing\ndescription: Testar software com verificação\n---\n\n# Testing\n\nExecute os testes e confirme a saída antes de concluir.';
  const env = await fixture(async () => JSON.stringify({ action: 'update', skillId: 'testing', reason: 'Melhoria.', confidence: 0.9, proposedContent: proposed }));
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const reviewed = await env.reviewer.review({ messages: [{ role: 'user', content: 'Teste' }, { role: 'assistant', content: 'Validado' }], activeSkills: ['testing'] });
  await assert.rejects(env.reviewer.resolve(reviewed.proposal.id, true), /Adote esta skill/);
  assert.equal(await fs.readFile(path.join(env.skillsRoot, 'testing', 'SKILL.md'), 'utf8'), env.markdown);
});

test('rollback restaura exatamente a versão anterior aplicada', async (t) => {
  const proposed = '---\nid: testing\nname: Testing\ndescription: Testar software com rollback\n---\n\n# Testing\n\nExecute, valide e registre os testes.';
  const env = await fixture(async () => JSON.stringify({ action: 'update', skillId: 'testing', reason: 'Melhoria.', confidence: 0.9, proposedContent: proposed }));
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const reviewed = await env.reviewer.review({ messages: [{ role: 'user', content: 'Teste' }, { role: 'assistant', content: 'Validado' }], activeSkills: ['testing'] });
  await env.reviewer.setSkillPolicy('testing', { adopt: true });
  await env.reviewer.resolve(reviewed.proposal.id, true);
  const result = await env.reviewer.rollback(reviewed.proposal.id);
  assert.equal(result.proposal.status, 'rolled_back');
  assert.equal(await fs.readFile(path.join(env.skillsRoot, 'testing', 'SKILL.md'), 'utf8'), env.markdown);
});

test('exporta e importa SKILL.md e recursos sem permitir paths arbitrários', async (t) => {
  const env = await fixture(async () => '{"action":"none"}');
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await fs.mkdir(path.join(env.skillsRoot, 'testing', 'references'), { recursive: true });
  await fs.writeFile(path.join(env.skillsRoot, 'testing', 'references', 'checklist.md'), 'Checklist seguro');
  const document = await env.reviewer.exportSkill('testing');
  await fs.rm(path.join(env.skillsRoot, 'testing'), { recursive: true, force: true });
  const imported = await env.reviewer.importSkill(document);
  assert.equal(imported.id, 'testing');
  assert.equal(await fs.readFile(path.join(env.skillsRoot, 'testing', 'references', 'checklist.md'), 'utf8'), 'Checklist seguro');
  const forged = structuredClone(document);
  forged.files.push({ path: '../escape.txt', encoding: 'base64', content: Buffer.from('x').toString('base64') });
  await assert.rejects(env.reviewer.importSkill(forged, { overwrite: true }), /fora das pastas/);
});
