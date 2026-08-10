const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const DEFAULT_PROVIDER = process.env.JARVIS_WEB_SEARCH_PROVIDER || 'bing';
const execFileAsync = promisify(execFile);

function certificateError(error) {
  for (let current = error; current; current = current.cause) {
    if (/certificate|UNABLE_TO_VERIFY/i.test(`${current.code || ''} ${current.message || ''}`)) return true;
  }
  return false;
}

async function fetchText(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`A busca web respondeu com HTTP ${response.status}.`);
    return response.text();
  } catch (error) {
    if (process.platform !== 'win32' || !certificateError(error)) throw error;
    const args = ['--fail', '--silent', '--show-error', '--location', '--max-time', '15'];
    for (const [name, value] of Object.entries(headers)) args.push('--header', `${name}: ${value}`);
    args.push(url);
    const { stdout } = await execFileAsync('curl.exe', args, { windowsHide: true, maxBuffer: 2_000_000 });
    return stdout;
  }
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function textFromHtml(value = '') {
  return decodeHtml(String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function normalizeUrl(value = '') {
  try {
    const url = new URL(decodeHtml(value));
    if (url.hostname === 'duckduckgo.com' && url.pathname === '/l/') {
      const redirected = url.searchParams.get('uddg');
      if (redirected) return normalizeUrl(redirected);
    }
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function parseDuckDuckGo(html, maxResults) {
  const blocks = String(html).split(/<div class="result(?:[^>]*)">/i).slice(1);
  const results = [];
  for (const block of blocks) {
    const anchor = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = normalizeUrl(anchor[1]);
    const title = textFromHtml(anchor[2]);
    const snippet = textFromHtml(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '');
    if (!url || !title) continue;
    results.push({ title: title.slice(0, 300), url, snippet: snippet.slice(0, 900) });
    if (results.length >= maxResults) break;
  }
  return results;
}

function tagValue(xml, tag) {
  const value = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '';
  return textFromHtml(value.replace(/^<!\[CDATA\[|\]\]>$/g, ''));
}

function parseBingRss(xml, maxResults) {
  const items = String(xml).match(/<item>[\s\S]*?<\/item>/gi) || [];
  return items.map((item) => ({
    title: tagValue(item, 'title').slice(0, 300),
    url: normalizeUrl(tagValue(item, 'link')),
    snippet: tagValue(item, 'description').slice(0, 900),
  })).filter((item) => item.url && item.title).slice(0, maxResults);
}

async function searchBrave(query, maxResults) {
  const apiKey = process.env.JARVIS_BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error('Defina JARVIS_BRAVE_SEARCH_API_KEY para usar o provedor Brave.');
  let payload;
  try {
    payload = JSON.parse(await fetchText(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
      { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    ));
  } catch (error) {
    throw new Error(`Brave Search: ${error.message}`);
  }
  return (payload.web?.results || []).map((item) => ({
    title: String(item.title || '').slice(0, 300),
    url: normalizeUrl(item.url),
    snippet: String(item.description || '').slice(0, 900),
  })).filter((item) => item.url && item.title);
}

async function searchDuckDuckGo(query, maxResults) {
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    'User-Agent': 'Mozilla/5.0 (compatible; JARVIS/0.1)',
  });
  return parseDuckDuckGo(html, maxResults);
}

async function searchBing(query, maxResults) {
  const xml = await fetchText(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, {
    'User-Agent': 'Mozilla/5.0 (compatible; JARVIS/0.1)',
  });
  return parseBingRss(xml, maxResults);
}

async function searchWeb({ query, maxResults = 5 } = {}) {
  const normalizedQuery = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 512);
  if (!normalizedQuery) throw new Error('Informe uma consulta para a busca web.');
  const limit = Math.max(1, Math.min(8, Number(maxResults) || 5));
  const provider = String(DEFAULT_PROVIDER).toLowerCase();
  const results = provider === 'brave'
    ? await searchBrave(normalizedQuery, limit)
    : provider === 'duckduckgo'
      ? await searchDuckDuckGo(normalizedQuery, limit)
      : await searchBing(normalizedQuery, limit);
  return {
    query: normalizedQuery,
    provider,
    untrusted: true,
    results,
  };
}

module.exports = { parseBingRss, parseDuckDuckGo, searchWeb };
