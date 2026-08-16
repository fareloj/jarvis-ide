const serviceManager = require('./rag-service-manager');

async function baseUrl() {
  return (await serviceManager.readConfig()).endpoint;
}

async function requestJson(path, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  const response = await fetch(`${await baseUrl()}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || `RAG respondeu com HTTP ${response.status}.`);
  }
  return payload;
}

async function health() {
  const url = await baseUrl();
  try {
    return { online: true, url, details: await requestJson('/health', { timeoutMs: 6_000 }) };
  } catch (error) {
    return { online: false, url, error: error.message };
  }
}

async function search({ query, topK = 6, useReranker = true, filters = {} } = {}) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) throw new Error('Informe uma consulta para o RAG.');
  return requestJson('/v1/search', {
    method: 'POST',
    timeoutMs: useReranker ? 60_000 : 20_000,
    body: {
      query: normalizedQuery.slice(0, 8_000),
      top_k: Math.max(1, Math.min(20, Number(topK) || 6)),
      use_reranker: Boolean(useReranker),
      filters,
    },
  });
}

async function indexCorpus({ containerPath, name, corpus } = {}, options = {}) {
  if (!String(containerPath || '').startsWith('/jarvis-workspace/')) {
    throw new Error('O corpus precisa estar no staging seguro do JARVIS.');
  }
  const corpusName = String(name || corpus || '').trim();
  if (!corpusName) throw new Error('Nome do corpus inválido.');

  const steps = [
    ['ingest', '/ingest', { root_path: containerPath, name: corpusName }, 120_000],
    ['embed', '/embed', { limit: 100 }, 120_000],
    ['dense', '/dense/reindex', undefined, 180_000],
    ['lexical', '/lexical/reindex', undefined, 180_000],
  ];
  const results = {};
  for (let index = 0; index < steps.length; index += 1) {
    const [step, endpoint, body, timeoutMs] = steps[index];
    options.onProgress?.({ step, index, total: steps.length, percent: Math.round((index / steps.length) * 100) });
    if (step === 'embed') {
      const batches = [];
      let embedded = 0;
      for (let batch = 0; batch < 200; batch += 1) {
        const result = await requestJson(endpoint, { method: 'POST', body, timeoutMs });
        batches.push(result);
        embedded += Number(result.embedded || 0);
        options.onProgress?.({
          step,
          index,
          total: steps.length,
          percent: 25 + Math.min(20, Math.round(embedded / 100)),
          embedded,
          batch: batch + 1,
        });
        if (Number(result.requested || 0) < body.limit) break;
      }
      results[step] = { ...batches.at(-1), embedded, batches: batches.length };
    } else {
      results[step] = await requestJson(endpoint, {
        method: 'POST',
        ...(body !== undefined ? { body } : {}),
        timeoutMs,
      });
    }
    options.onProgress?.({
      step,
      index: index + 1,
      total: steps.length,
      percent: Math.round(((index + 1) / steps.length) * 100),
    });
  }
  return { corpus: corpusName, ...results };
}

module.exports = { health, indexCorpus, search };
