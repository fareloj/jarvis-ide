const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildInspectionInvocation, buildReviewInvocation, buildTaskInvocation, createEventParser,
} = require('./coding-agent-cli');

const cwd = path.join(os.tmpdir(), 'jarvis-agent-cli');

test('inicia cada CLI em modo estruturado e confinado', () => {
  const agy = buildTaskInvocation('antigravity', { cwd, prompt: 'Teste', timeoutMs: 60_000 });
  assert.ok(agy.args.includes('stream-json'));
  assert.ok(agy.args.includes('--sandbox'));
  assert.ok(agy.args.includes(path.resolve(cwd)));

  const codex = buildTaskInvocation('codex', { cwd, prompt: 'Teste', outputFile: 'final.txt' });
  assert.ok(codex.args.includes('--json'));
  assert.ok(codex.args.includes('workspace-write'));

  const claude = buildTaskInvocation('claude-code', { cwd, prompt: 'Teste' });
  assert.ok(claude.args.includes('stream-json'));
  assert.ok(claude.args.includes('--include-partial-messages'));
});

test('retoma a sessao pelo identificador nativo de cada CLI', () => {
  assert.deepEqual(buildTaskInvocation('antigravity', { cwd, prompt: 'Siga', sessionId: 'agy-1' }).args.slice(0, 2), ['--conversation', 'agy-1']);
  const codex = buildTaskInvocation('codex', { cwd, prompt: 'Siga', sessionId: 'cx-1', outputFile: 'out' });
  assert.deepEqual(codex.args.slice(0, 3), ['exec', 'resume', 'cx-1']);
  assert.ok(codex.args.includes('sandbox_mode="workspace-write"'));
  assert.deepEqual(buildTaskInvocation('claude-code', { cwd, prompt: 'Siga', sessionId: 'cl-1' }).args.slice(0, 2), ['--resume', 'cl-1']);
});

test('constroi revisoes e rejeita combinacoes sem suporte', () => {
  assert.deepEqual(buildReviewInvocation('codex', { cwd, targetType: 'base', target: 'main' }).args, ['review', '--base', 'main']);
  assert.deepEqual(buildReviewInvocation('codex', { cwd, targetType: 'uncommitted', focus: 'concorrencia' }).args, ['review', '--uncommitted', 'concorrencia']);
  assert.throws(() => buildReviewInvocation('codex', { cwd, targetType: 'pull-request', target: '12' }), /nao aceita pull request/);
  assert.throws(() => buildReviewInvocation('claude-code', { cwd, targetType: 'commit' }), /alvo e obrigatorio/);
});

test('limita inventario ao que cada CLI realmente oferece', () => {
  assert.deepEqual(buildInspectionInvocation('codex', 'doctor').args, ['doctor', '--json']);
  assert.deepEqual(buildInspectionInvocation('claude-code', 'agents').args, ['agents', '--json', '--all']);
  assert.deepEqual(buildInspectionInvocation('antigravity', 'agents').args, ['agent']);
  assert.deepEqual(buildInspectionInvocation('antigravity', 'plugins').args, ['plugin', 'list']);
  assert.throws(() => buildInspectionInvocation('antigravity', 'doctor'), /nao oferece/);
});

test('parser extrai ids e estados dos tres protocolos', () => {
  const cases = [
    ['antigravity', '{"event":"init","conversation_id":"a1","init":{"cwd":"C:/p"}}\n{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n', 'a1', 'ok'],
    ['claude-code', '{"type":"system","subtype":"init","session_id":"c1"}\n{"type":"result","session_id":"c1","result":"ok","is_error":false}\n', 'c1', 'ok'],
    ['codex', '{"type":"thread.started","thread_id":"x1"}\n{"type":"turn.completed"}\n', 'x1', ''],
  ];
  for (const [agent, input, expectedId, expectedText] of cases) {
    const parser = createEventParser(agent);
    parser.push(input);
    const result = parser.finish();
    assert.equal(result.sessionId, expectedId);
    assert.equal(result.finalText, expectedText);
    assert.equal(result.finalStatus, 'SUCCESS');
  }
});
