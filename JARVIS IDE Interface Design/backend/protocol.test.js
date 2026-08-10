const test = require('node:test');
const assert = require('node:assert/strict');
const { EVENT_TYPES, createRunEvent } = require('./protocol');

test('evento do runtime usa envelope estável', () => {
  const event = createRunEvent('run-123', EVENT_TYPES.MESSAGE_DELTA, { content: 'Olá' });
  assert.equal(event.runId, 'run-123');
  assert.equal(event.type, 'message.delta');
  assert.deepEqual(event.payload, { content: 'Olá' });
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
});

test('evento rejeita tipo fora do protocolo', () => {
  assert.throws(() => createRunEvent('run-123', 'tool.magic'), /Evento desconhecido/);
});
