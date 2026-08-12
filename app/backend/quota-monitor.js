const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 20_000; // janela curta o suficiente pra parecer "tempo real" sem martelar o ollama.com

let sessionCookie = process.env.OLLAMA_SESSION_COOKIE || '';
let cachedCloudUsage = null;
let lastCloudSyncAt = null;
let inFlightSync = null;

function setSessionCookie(cookie) {
  sessionCookie = String(cookie || '').trim();
  cachedCloudUsage = null;
  lastCloudSyncAt = null;
  inFlightSync = null;
}

function getSessionCookie() {
  return sessionCookie;
}

function certificateError(error) {
  for (let current = error; current; current = current.cause) {
    if (/certificate|UNABLE_TO_VERIFY/i.test(`${current.code || ''} ${current.message || ''}`)) return true;
  }
  return false;
}

async function fetchSettingsHtml(cookie = sessionCookie) {
  const normalizedCookie = String(cookie || sessionCookie || '').trim();
  if (!normalizedCookie) {
    throw new Error('Cookie de sessão da Ollama Cloud não configurado.');
  }

  const url = 'https://ollama.com/settings';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    Cookie: normalizedCookie.includes('=') ? normalizedCookie : `wos-session=${normalizedCookie}; ollama_session=${normalizedCookie}`,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Ollama Cloud respondeu com HTTP ${response.status}.`);
    return await response.text();
  } catch (error) {
    if (process.platform !== 'win32' || !certificateError(error)) throw error;
    const args = ['--fail', '--silent', '--show-error', '--location', '--max-time', '15'];
    for (const [name, value] of Object.entries(headers)) args.push('--header', `${name}: ${value}`);
    args.push(url);
    const { stdout } = await execFileAsync('curl.exe', args, { windowsHide: true, maxBuffer: 2_000_000 });
    return stdout;
  }
}

function parsePercentage(text) {
  if (!text) return 0;
  const match = String(text).match(/([\d.,]+)\s*%/);
  if (!match) return 0;
  return Number.parseFloat(match[1].replace(',', '.')) || 0;
}

function parseCloudUsageHtml(html) {
  if (!html || typeof html !== 'string') {
    throw new Error('Conteúdo HTML inválido.');
  }

  // Verifica se a resposta foi redirecionada para a tela de login
  if (html.includes('Sign in to Ollama') || (html.includes('/login') && !html.includes('Cloud usage'))) {
    throw new Error('Sessão expirada ou cookie inválido da Ollama.');
  }

  // Extrai plano (Free, Pro, Max)
  const planMatch = html.match(/Cloud\s+usage\s*<span[^>]*class="[^"]*badge[^"]*"[^>]*>([\w\s]+)<\/span>/i)
    || html.match(/Cloud\s+usage\s*<span[^>]*>([\w\s]+)<\/span>/i)
    || html.match(/Cloud\s+usage\s*([\w\s]+)/i);
  const plan = planMatch ? planMatch[1].trim() : 'Free';

  // Extrai Session Usage
  let sessionUsagePercent = 0;
  let sessionResetText = 'Reseta em 5 horas';
  const sessionMatch = html.match(/Session\s+usage[\s\S]*?([\d.,]+\s*%\s*used)/i)
    || html.match(/Session\s+usage[\s\S]*?([\d.,]+\s*%)/i);
  if (sessionMatch) {
    sessionUsagePercent = parsePercentage(sessionMatch[1]);
  }
  const sessionResetMatch = html.match(/Session\s+usage[\s\S]*?Resets\s+in\s+([^<\n]+)/i);
  if (sessionResetMatch) {
    sessionResetText = `Reseta em ${sessionResetMatch[1].trim()}`;
  }

  // Extrai Weekly Usage
  let weeklyUsagePercent = 0;
  let weeklyResetText = 'Reseta em 7 dias';
  const weeklyMatch = html.match(/Weekly\s+usage[\s\S]*?([\d.,]+\s*%\s*used)/i)
    || html.match(/Weekly\s+usage[\s\S]*?([\d.,]+\s*%)/i);
  if (weeklyMatch) {
    weeklyUsagePercent = parsePercentage(weeklyMatch[1]);
  }
  const weeklyResetMatch = html.match(/Weekly\s+usage[\s\S]*?Resets\s+in\s+([^<\n]+)/i);
  if (weeklyResetMatch) {
    weeklyResetText = `Reseta em ${weeklyResetMatch[1].trim()}`;
  }

  // Extrai Modelos Utilizados na semana
  const modelsUsed = [];
  const modelsSectionMatch = html.match(/Models\s+used\s+this\s+week[\s\S]*?(?:<\/section>|<\/main>|<\/div>\s*<\/div>|Notify\s+me|$)/i);
  const modelsSection = modelsSectionMatch ? modelsSectionMatch[0] : html;

  const modelRegex = /([a-z0-9_.:-]+)(?:<[^>]*>|\s)+([\d.,]+)\s*requests?/gi;
  const seen = new Set();
  const ignoredNames = new Set(['models', 'requests', 'session', 'weekly', 'cloud', 'usage', 'free', 'pro', 'max', 'span', 'div', 'li', 'ul', 'class']);
  let match;
  while ((match = modelRegex.exec(modelsSection)) !== null) {
    const name = match[1].trim();
    if (ignoredNames.has(name.toLowerCase()) || name.length < 2) continue;
    if (!seen.has(name)) {
      seen.add(name);
      modelsUsed.push({
        name,
        requests: Number.parseInt(match[2].replace(/[.,]/g, ''), 10) || 0,
      });
    }
  }

  return {
    source: 'cloud',
    plan,
    session: {
      usedPercent: sessionUsagePercent,
      resetText: sessionResetText,
    },
    weekly: {
      usedPercent: weeklyUsagePercent,
      resetText: weeklyResetText,
    },
    models: modelsUsed,
    syncedAt: new Date().toISOString(),
  };
}

async function syncCloudUsage(cookie = sessionCookie) {
  const targetCookie = cookie || sessionCookie;
  const html = await fetchSettingsHtml(targetCookie);
  const parsed = parseCloudUsageHtml(html);
  cachedCloudUsage = parsed;
  lastCloudSyncAt = Date.now();
  return parsed;
}

// Deduplica syncs concorrentes (poll automático + refresh pós-mensagem + popover
// abrindo ao mesmo tempo) numa única requisição em andamento pro ollama.com.
function syncCloudUsageDeduped() {
  if (!inFlightSync) {
    inFlightSync = syncCloudUsage().finally(() => {
      inFlightSync = null;
    });
  }
  return inFlightSync;
}

async function getQuotaStatus(forceRefresh = false) {
  const hasCookie = Boolean(sessionCookie);

  if (!hasCookie) {
    return {
      source: 'unconfigured',
      hasCookie: false,
      message: 'Configure seu cookie de sessão da Ollama para sincronizar a quota diretamente.',
      session: null,
      weekly: null,
      models: [],
      syncedAt: null,
    };
  }

  // Retorna cache recente a menos que forceRefresh seja solicitado
  if (!forceRefresh && cachedCloudUsage && lastCloudSyncAt && (Date.now() - lastCloudSyncAt < CACHE_TTL_MS)) {
    return {
      ...cachedCloudUsage,
      hasCookie: true,
    };
  }

  try {
    const cloud = await syncCloudUsageDeduped();
    return {
      ...cloud,
      hasCookie: true,
    };
  } catch (error) {
    return {
      source: 'error',
      hasCookie: true,
      error: error.message,
      session: cachedCloudUsage?.session || null,
      weekly: cachedCloudUsage?.weekly || null,
      models: cachedCloudUsage?.models || [],
      syncedAt: cachedCloudUsage?.syncedAt || null,
    };
  }
}

module.exports = {
  fetchSettingsHtml,
  getQuotaStatus,
  getSessionCookie,
  parseCloudUsageHtml,
  parsePercentage,
  setSessionCookie,
  syncCloudUsage,
};
