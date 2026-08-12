const assert = require('node:assert/strict');
const test = require('node:test');
const { detectDefaultProvider, searchWeb } = require('./web-search');

const ENV_KEYS = ['JARVIS_WEB_SEARCH_PROVIDER', 'JARVIS_TAVILY_API_KEY', 'JARVIS_BRAVE_SEARCH_API_KEY'];

function withEnv(overrides, fn) {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    });
}

test('detectDefaultProvider escolhe o melhor provedor disponível pelas chaves configuradas', async () => {
  await withEnv({}, () => assert.equal(detectDefaultProvider(), 'duckduckgo'));
  await withEnv({ JARVIS_BRAVE_SEARCH_API_KEY: 'x' }, () => assert.equal(detectDefaultProvider(), 'brave'));
  await withEnv({ JARVIS_TAVILY_API_KEY: 'x', JARVIS_BRAVE_SEARCH_API_KEY: 'x' }, () => assert.equal(detectDefaultProvider(), 'tavily'));
  await withEnv({ JARVIS_WEB_SEARCH_PROVIDER: 'bing', JARVIS_TAVILY_API_KEY: 'x' }, () => assert.equal(detectDefaultProvider(), 'bing'));
});

test('searchWeb com Tavily extrai title/url/content limpos da resposta', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });

  global.fetch = async (url, init) => {
    assert.equal(url, 'https://api.tavily.com/search');
    assert.equal(init.method, 'POST');
    assert.match(init.headers.Authorization, /^Bearer /);
    const body = JSON.parse(init.body);
    assert.equal(body.query, 'JARVIS documentação');
    return new Response(JSON.stringify({
      results: [{ title: 'Documentação', url: 'https://example.com/docs', content: 'Referência e exemplo.' }],
    }), { status: 200 });
  };

  await withEnv({ JARVIS_TAVILY_API_KEY: 'test-key' }, async () => {
    const outcome = await searchWeb({ query: 'JARVIS documentação', maxResults: 3 });
    assert.equal(outcome.provider, 'tavily');
    assert.equal(outcome.untrusted, true);
    assert.deepEqual(outcome.results, [
      { title: 'Documentação', url: 'https://example.com/docs', snippet: 'Referência e exemplo.' },
    ]);
  });
});
