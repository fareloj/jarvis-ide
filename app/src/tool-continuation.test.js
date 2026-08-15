const test = require('node:test');
const assert = require('node:assert/strict');
const continuation = require('./tool-continuation');

test('resultado da tool fica depois do histórico e vira o último turno', () => {
  const messages = continuation.buildMessages({
    baseSystemPrompt: 'base',
    dateContext: 'data',
    history: [
      { role: 'user', content: 'salve uma memória' },
      { role: 'assistant', content: 'vou salvar' },
    ],
    outcome: { name: 'memory_save', status: 'completed', result: { id: 'mem-1' } },
  });

  assert.deepEqual(messages.slice(0, 3).map((message) => message.role), ['system', 'system', 'system']);
  assert.deepEqual(messages.slice(3, 5).map((message) => message.content), ['salve uma memória', 'vou salvar']);
  assert.equal(messages.at(-1).role, 'user');
  assert.match(messages.at(-1).content, /"id": "mem-1"/);
});

test('fallback sempre informa o estado final da tool', () => {
  assert.match(continuation.fallbackFor({ name: 'terminal_run', status: 'timeout' }), /tempo limite/i);
  assert.match(continuation.fallbackFor({ name: 'terminal_run', status: 'failed' }), /falha/i);
  assert.match(continuation.fallbackFor({ name: 'memory_save', status: 'completed' }), /sucesso/i);
  assert.match(continuation.fallbackFor({ name: 'memory_save', status: 'denied' }), /recusada/i);
});

test('job confirmado vivo gera uma atualização de início, não de conclusão', () => {
  const messages = continuation.buildMessages({
    baseSystemPrompt: 'base',
    dateContext: 'data',
    history: [],
    outcome: {
      name: 'delegate_coding_task',
      status: 'running',
      result: { jobId: 'delegate-123', processId: 4242, externalId: 'agy-abc', alive: true },
    },
  });
  assert.match(messages[2].content, /NÃO prova que a tarefa começou/);
  assert.match(messages[2].content, /autenticando/);
  assert.match(messages[2].content, /não diga "criando"/i);
  assert.match(messages[2].content, /jobId/);
  assert.match(messages.at(-1).content, /delegate-123/);
  assert.match(continuation.fallbackFor({ name: 'delegate_coding_task', status: 'running' }), /iniciada/i);
});
