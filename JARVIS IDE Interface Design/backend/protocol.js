const EVENT_TYPES = Object.freeze({
  MESSAGE_DELTA: 'message.delta',
  MESSAGE_DONE: 'message.done',
  RUN_FAILED: 'run.failed',
  RUN_CANCELLED: 'run.cancelled',
});

function createRunEvent(runId, type, payload = {}) {
  if (!runId || typeof runId !== 'string') throw new Error('runId inválido.');
  if (!Object.values(EVENT_TYPES).includes(type)) throw new Error(`Evento desconhecido: ${type}`);
  return {
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

module.exports = { EVENT_TYPES, createRunEvent };
