const test = require('node:test');
const assert = require('node:assert/strict');

test('cliente RAG rejeita consulta vazia antes da rede', async () => {
  const rag = require('./rag-client');
  await assert.rejects(() => rag.search({ query: '  ' }), /Informe uma consulta/);
});

test('cliente RAG limita ingestão ao staging do JARVIS', async () => {
  const rag = require('./rag-client');
  await assert.rejects(
    () => rag.indexCorpus({ containerPath: '/workspace', name: 'fora' }),
    /staging seguro/,
  );
});
