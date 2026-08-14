const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CHECKPOINT_VERSION,
  DEFAULT_BUDGET,
  redactSecrets,
  getIdempotencyKey,
  isIdempotentTool,
  isTransientError,
  safeRetry,
  compactConversation,
  CheckpointStore,
  JobQueue,
} = require('./agent-runtime');

test('redactSecrets sanitiza chaves de API, tokens e senhas em strings e objetos', () => {
  const input = {
    apiKey: 'sk-1234567890123456789012',
    token: 'ghp_123456789012345678901234567890123456',
    password: 'superSecretPassword123',
    authorization: 'Bearer secret_token_xyz',
    normalField: 'Hello World',
    nested: {
      deepSecret: 'Bearer abcdef123456789',
      count: 42,
    },
    list: ['Bearer 12345', 'safe item'],
  };

  const output = redactSecrets(input);

  assert.equal(output.apiKey, '[REDACTED_SECRET]');
  assert.equal(output.token, '[REDACTED_SECRET]');
  assert.equal(output.password, '[REDACTED_SECRET]');
  assert.equal(output.authorization, 'Bearer [REDACTED_SECRET]');
  assert.equal(output.normalField, 'Hello World');
  assert.equal(output.nested.deepSecret, 'Bearer [REDACTED_SECRET]');
  assert.equal(output.nested.count, 42);
  assert.equal(output.list[0], 'Bearer [REDACTED_SECRET]');
  assert.equal(output.list[1], 'safe item');
});

test('getIdempotencyKey gera chaves determinísticas independente da ordem das chaves', () => {
  const key1 = getIdempotencyKey('run-1', 'project_read_file', { path: 'src/app.js', encoding: 'utf8' });
  const key2 = getIdempotencyKey('run-1', 'project_read_file', { encoding: 'utf8', path: 'src/app.js' });
  const key3 = getIdempotencyKey('run-2', 'project_read_file', { path: 'src/app.js', encoding: 'utf8' });

  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
});

test('isIdempotentTool classifica corretamente leituras seguras versus mutações', () => {
  assert.equal(isIdempotentTool('project_read_file'), true);
  assert.equal(isIdempotentTool('project_list_files'), true);
  assert.equal(isIdempotentTool('web_search'), true);
  assert.equal(isIdempotentTool('rag_search'), true);

  assert.equal(isIdempotentTool('project_write_file'), false);
  assert.equal(isIdempotentTool('project_apply_patch'), false);
  assert.equal(isIdempotentTool('terminal_run'), false);
  assert.equal(isIdempotentTool('delegate_coding_task'), false);
});

test('isTransientError identifica erros recuperáveis de rede e sobrecarga', () => {
  assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isTransientError({ message: 'Ollama respondeu com HTTP 503 Service Unavailable.' }), true);
  assert.equal(isTransientError({ message: 'Rate limit exceeded (HTTP 429)' }), true);

  assert.equal(isTransientError({ message: 'Arquivo não encontrado (HTTP 404)' }), false);
  assert.equal(isTransientError({ message: 'Comando recusado pelo usuário.' }), false);
  assert.equal(isTransientError(null), false);
});

test('safeRetry tenta novamente apenas erros transitórios com backoff', async () => {
  let attempts = 0;
  const result = await safeRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const err = new Error('HTTP 503 Service Unavailable');
      err.code = 'ECONNRESET';
      throw err;
    }
    return 'success';
  }, { maxRetries: 3, initialDelayMs: 10 });

  assert.equal(result, 'success');
  assert.equal(attempts, 3);

  // Erro não transitório deve falhar imediatamente sem retry
  let nonTransientAttempts = 0;
  await assert.rejects(async () => {
    await safeRetry(async () => {
      nonTransientAttempts += 1;
      throw new Error('Parâmetro inválido 400');
    }, { maxRetries: 3, initialDelayMs: 10 });
  }, /400/);

  assert.equal(nonTransientAttempts, 1);
});

test('compactConversation preserva system prompt, objetivo inicial e mensagens recentes', () => {
  const longText = 'x'.repeat(2000);
  const messages = [
    { role: 'system', content: 'Você é o JARVIS assistente de código.' },
    { role: 'user', content: 'Objetivo principal: Criar um servidor HTTP.' },
    { role: 'assistant', content: `Vou ler os arquivos do projeto. ${longText}`, tool_calls: [{ function: { name: 'project_list_files' } }] },
    { role: 'tool', tool_name: 'project_list_files', content: `["a.js", "b.js"] ${longText}` },
    { role: 'assistant', content: `Vou ler mais coisas. ${longText}`, tool_calls: [{ function: { name: 'project_read_file' } }] },
    { role: 'tool', tool_name: 'project_read_file', content: `Conteúdo longo ${longText}` },
    { role: 'assistant', content: 'Concluí a leitura inicial.' },
    { role: 'user', content: 'Agora crie o endpoint /health.' },
    { role: 'assistant', content: 'Criando o endpoint /health agora.' },
  ];

  const compacted = compactConversation(messages, { maxChars: 2000, preserveRecent: 3 });

  assert.equal(compacted[0].role, 'system');
  assert.equal(compacted[0].content, 'Você é o JARVIS assistente de código.');
  assert.equal(compacted[1].role, 'user');
  assert.equal(compacted[1].content, 'Objetivo principal: Criar um servidor HTTP.');

  // Mensagem intermediária de resumo
  const summaryMsg = compacted.find((m) => m.content && m.content.includes('Resumo determinístico'));
  assert.ok(summaryMsg);

  // Últimas 3 mensagens preservadas
  const last3 = compacted.slice(-3);
  assert.equal(last3[0].content, 'Concluí a leitura inicial.');
  assert.equal(last3[1].content, 'Agora crie o endpoint /health.');
  assert.equal(last3[2].content, 'Criando o endpoint /health agora.');
});

test('CheckpointStore salva atomicamente, versiona e rastreia idempotência de tools', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-checkpoints-test-'));
  try {
    const store = new CheckpointStore(tmpDir);
    const runId = 'run-test-123';

    const saved = await store.saveCheckpoint(runId, {
      sessionId: 'session-456',
      projectPath: '/test/proj',
      token: 'sk-1234567890123456789012',
      metrics: { turns: 3 },
    });

    assert.equal(saved.version, CHECKPOINT_VERSION);
    assert.equal(saved.token, '[REDACTED_SECRET]');

    const loaded = await store.getCheckpoint(runId);
    assert.equal(loaded.runId, runId);
    assert.equal(loaded.sessionId, 'session-456');
    assert.equal(loaded.token, '[REDACTED_SECRET]');

    // Gravação e conferência de tool idempotente
    const key = await store.recordExecutedTool(runId, 'project_read_file', { path: 'a.js' }, { content: 'hello' });
    assert.ok(key);

    const executed = await store.hasExecutedTool(runId, 'project_read_file', { path: 'a.js' });
    assert.ok(executed);
    assert.equal(executed.result.content, 'hello');

    const notExecuted = await store.hasExecutedTool(runId, 'project_read_file', { path: 'b.js' });
    assert.equal(notExecuted, null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('JobQueue gerencia ciclo de vida, eventos e cancelamento de jobs', async () => {
  const queue = new JobQueue();
  const runId = 'job-run-789';

  const job = queue.createJob({ runId, type: 'agent_run', projectPath: '/workspace' });
  assert.equal(job.status, 'running');

  queue.appendEvent(runId, { type: 'DELTA', content: 'Olá' });
  assert.equal(queue.getJob(runId).events.length, 1);

  const jobsList = queue.listJobs();
  assert.equal(jobsList.length, 1);
  assert.equal(jobsList[0].runId, runId);

  const cancelled = await queue.cancelJob(runId);
  assert.equal(cancelled, true);
  assert.equal(queue.getJob(runId).status, 'cancelled');
});
