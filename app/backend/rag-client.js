const DEFAULT_RAG_URL = (process.env.JARVIS_RAG_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');

async function requestJson(path, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  const response = await fetch(`${DEFAULT_RAG_URL}${path}`, {
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
  try {
    return { online: true, url: DEFAULT_RAG_URL, details: await requestJson('/health', { timeoutMs: 6_000 }) };
  } catch (error) {
    return { online: false, url: DEFAULT_RAG_URL, error: error.message };
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

async function indexCorpus({ containerPath, name, corpus } = {}) {
  if (!String(containerPath || '').startsWith('/jarvis-workspace/')) {
    throw new Error('O corpus precisa estar no staging seguro do JARVIS.');
  }
  const corpusName = String(name || corpus || '').trim();
  if (!corpusName) throw new Error('Nome do corpus inválido.');

  const ingest = await requestJson('/ingest', {
    method: 'POST',
    body: { root_path: containerPath, name: corpusName },
    timeoutMs: 120_000,
  });
  const embed = await requestJson('/embed', { method: 'POST', body: {}, timeoutMs: 900_000 });
  const dense = await requestJson('/dense/reindex', { method: 'POST', timeoutMs: 180_000 });
  const lexical = await requestJson('/lexical/reindex', { method: 'POST', timeoutMs: 180_000 });
  return { corpus: corpusName, ingest, embed, dense, lexical };
}

module.exports = { health, indexCorpus, search };
