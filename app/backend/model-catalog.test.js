const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('./model-catalog');

test('normaliza nivel de uso, parametros e rotulo do modelo', () => {
  assert.equal(catalog.nivelDe('gpt-oss:20b-cloud'), 'low');
  assert.equal(catalog.nivelDe('nemotron-3-ultra:cloud'), 'high');
  assert.equal(catalog.formatarParametros(120_000_000_000), '120B');
  assert.equal(catalog.formatarParametros(null), null);
  assert.equal(catalog.rotuloDe('kimi-k2.7-code:cloud'), 'Kimi K2.7 Code');
});

test('lista somente modelos cloud e preserva capacidades retornadas pelo Ollama', async () => {
  const fetchOriginal = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/tags')) {
      return {
        ok: true,
        json: async () => ({
          models: [
            { name: 'nemotron-3-super:cloud' },
            { name: 'gpt-oss:20b-cloud' },
            { name: 'llama3.2:latest' },
          ],
        }),
      };
    }
    const body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        capabilities: body.model.startsWith('nemotron')
          ? ['completion', 'tools', 'thinking']
          : ['completion', 'tools'],
        details: { family: 'teste', parameter_size: body.model.startsWith('gpt') ? 20_000_000_000 : 120_000_000_000 },
      }),
    };
  };

  try {
    const resultado = await catalog.listCloudModels();
    assert.deepEqual(resultado.models.map((modelo) => modelo.id), [
      'gpt-oss:20b-cloud',
      'nemotron-3-super:cloud',
    ]);
    assert.equal(resultado.models[0].nivelDeUso, 'low');
    assert.equal(resultado.models[0].parametros, '20B');
    assert.equal(resultado.models[1].tools, true);
    assert.equal(resultado.models[1].thinking, true);
    assert.equal(resultado.models[1].multimodal, false);
  } finally {
    global.fetch = fetchOriginal;
  }
});

test('falha de conexao vira estado vazio utilizavel pela interface', async () => {
  const fetchOriginal = global.fetch;
  global.fetch = async () => { throw new Error('Ollama indisponivel'); };
  try {
    const resultado = await catalog.listCloudModels();
    assert.deepEqual(resultado.models, []);
    assert.match(resultado.error, /indisponivel/i);
  } finally {
    global.fetch = fetchOriginal;
  }
});
