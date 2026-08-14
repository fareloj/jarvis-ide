// Catalogo de modelos da Ollama Cloud.
//
// As capacidades (vision, tools, thinking) e o tamanho vem do proprio Ollama
// em tempo de execucao, entao um modelo novo aparece sem precisar editar
// codigo. O nivel de uso e' que precisa de um mapa curado: o Ollama nao
// publica preco por token — o que existe e' uma escala de 1 a 4 (low,
// medium, high, extra high) exibida na pagina de cada modelo em ollama.com,
// e ela nao volta pela API local.
const OLLAMA_HOST = (process.env.JARVIS_OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

// Coletado de ollama.com/library/<modelo> em 2026-08-14. A chave e' o nome
// base (sem a tag), porque o nivel acompanha o modelo, nao a variante.
const NIVEIS_DE_USO = {
  'gpt-oss': 'medium',
  'nemotron-3-nano': 'low',
  'nemotron-3-super': 'medium',
  'nemotron-3-ultra': 'high',
  'deepseek-v4-flash': 'medium',
  'deepseek-v4-pro': 'extra high',
  'glm-5.1': 'high',
  'glm-5.2': 'high',
  'kimi-k2.6': 'high',
  'kimi-k2.7-code': 'high',
  'minimax-m2.7': 'medium',
  'minimax-m3': 'high',
  'mistral-large-3': 'medium',
  'qwen3.5': 'medium',
};

// Excecoes por tag: o gpt-oss:20b custa menos que o 120b, e o site publica
// o nivel do 20b separadamente.
const NIVEIS_POR_TAG = {
  'gpt-oss:20b-cloud': 'low',
  'gpt-oss:120b-cloud': 'medium',
};

const ORDEM_DE_CUSTO = { low: 1, medium: 2, high: 3, 'extra high': 4 };

function nomeBase(modelo) {
  return String(modelo).split(':')[0];
}

function nivelDe(modelo) {
  return NIVEIS_POR_TAG[modelo] || NIVEIS_DE_USO[nomeBase(modelo)] || 'medium';
}

// "kimi-k2.7-code:cloud" -> "Kimi K2.7 Code"
function rotuloDe(modelo) {
  return nomeBase(modelo)
    .split('-')
    .map((parte) => (/^[a-z]/.test(parte) ? parte.charAt(0).toUpperCase() + parte.slice(1) : parte))
    .join(' ');
}

function formatarParametros(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e12) return `${(n / 1e12).toFixed(n >= 1e13 ? 0 : 2).replace(/\.?0+$/, '')}T`;
  if (n >= 1e9) return `${Math.round(n / 1e9)}B`;
  return `${Math.round(n / 1e6)}M`;
}

async function pedir(caminho, corpo) {
  const resposta = await fetch(`${OLLAMA_HOST}${caminho}`, {
    method: corpo ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.OLLAMA_API_KEY ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resposta.ok) throw new Error(`Ollama respondeu com HTTP ${resposta.status}.`);
  return resposta.json();
}

/**
 * Lista os modelos cloud com capacidades e nivel de uso.
 * Se o Ollama estiver fora, devolve lista vazia com o erro — a interface
 * mostra o aviso em vez de um catalogo inventado.
 */
async function listCloudModels() {
  let tags;
  try {
    tags = await pedir('/api/tags');
  } catch (error) {
    return { models: [], error: error.message };
  }

  const cloud = (tags.models || []).filter((m) => /(^|[:-])cloud$/.test(m.name) || m.name.includes('-cloud'));
  const modelos = await Promise.all(cloud.map(async (m) => {
    let detalhe = {};
    try {
      detalhe = await pedir('/api/show', { model: m.name });
    } catch {
      // Um modelo que nao responde ao /show ainda aparece, so' sem capacidades.
    }
    const capacidades = (detalhe.capabilities || []).filter((c) => c !== 'completion');
    const nivel = nivelDe(m.name);
    return {
      id: m.name,
      label: rotuloDe(m.name),
      familia: detalhe.details?.family || null,
      parametros: formatarParametros(detalhe.details?.parameter_size),
      multimodal: capacidades.includes('vision'),
      tools: capacidades.includes('tools'),
      thinking: capacidades.includes('thinking'),
      capacidades,
      nivelDeUso: nivel,
      ordemDeCusto: ORDEM_DE_CUSTO[nivel] || 2,
    };
  }));

  modelos.sort((a, b) => a.ordemDeCusto - b.ordemDeCusto || a.label.localeCompare(b.label));
  return { models: modelos };
}

module.exports = { ORDEM_DE_CUSTO, formatarParametros, listCloudModels, nivelDe, rotuloDe };
