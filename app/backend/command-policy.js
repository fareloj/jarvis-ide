// Fronteira de execucao para o terminal mediado pelo agente.
//
// O comportamento anterior era "PowerShell iniciado na pasta do projeto":
// herdava todo o ambiente do Electron (incluindo chaves de API), matava so'
// o processo pai no timeout deixando filhos orfaos, e nao registrava nada.
// Aqui a execucao vira uma operacao classificada, limitada e auditada.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const AUDIT_PATH = path.resolve(
  process.env.JARVIS_COMMAND_AUDIT_PATH || path.join(__dirname, '..', 'data', 'command-audit.jsonl'),
);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_COMMAND_LENGTH = 8_000;
const SYSTEM32_ROOT = path.resolve(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const SYSNATIVE_ROOT = path.resolve(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'Sysnative');

function isInsidePath(candidate, root) {
  const resolved = path.resolve(String(candidate || ''));
  const relative = path.relative(path.resolve(root), resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// O bypass remove a aprovacao humana, nao a fronteira expressamente escolhida
// pelo usuario. PowerShell permite montar caminhos de varias formas, entao
// expandimos as referencias usuais ao Windows antes da verificacao lexical.
// Isso nao pretende ser um sandbox do sistema operacional; a auditoria, o
// ambiente saneado, o timeout e o encerramento da arvore continuam ativos.
function assertBypassCommandAllowed(command, cwd) {
  const workingDirectory = path.resolve(String(cwd || ''));
  if (isInsidePath(workingDirectory, SYSTEM32_ROOT) || isInsidePath(workingDirectory, SYSNATIVE_ROOT)) {
    throw new Error('Modo bypass bloqueado: o diretório de trabalho está dentro do System32.');
  }

  const windowsRoot = path.resolve(process.env.SystemRoot || process.env.windir || 'C:\\Windows');
  const expanded = String(command || '')
    .replace(/%\s*(?:windir|systemroot)\s*%/gi, windowsRoot)
    .replace(/\$\{?env:(?:windir|systemroot)\}?/gi, windowsRoot)
    .replace(/\$\{?(?:windir|systemroot)\}?/gi, windowsRoot)
    .replace(/\//g, '\\');
  const compact = expanded.replace(/["'`\s+()]/g, '').toLowerCase();
  const blocked = [SYSTEM32_ROOT, SYSNATIVE_ROOT]
    .map((item) => item.replace(/\//g, '\\').toLowerCase());
  if (blocked.some((item) => compact.includes(item))) {
    throw new Error('Modo bypass bloqueado: o comando referencia o System32.');
  }
  if (/\[(?:system\.)?environment\]::systemdirectory|getfolderpath\([^)]*system/i.test(expanded)) {
    throw new Error('Modo bypass bloqueado: o comando tenta resolver o diretório System32 dinamicamente.');
  }
  const escapedWindowsRoot = windowsRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`join-path\\s+(?:["']?${escapedWindowsRoot}["']?)\\s+(?:["']?system32["']?)`, 'i').test(expanded)) {
    throw new Error('Modo bypass bloqueado: o comando tenta montar um caminho para o System32.');
  }
  return true;
}

// Classificacao por efeito. A ordem importa: o primeiro padrao que casar
// define a classe, e a mais perigosa vence porque destrutivo vem antes.
const CLASSES = [
  {
    classe: 'destruicao',
    // Remocao recursiva/forcada, formatacao, reset de historico, kill amplo.
    padroes: [
      /\b(rm|del|erase)\b[^|;]*\s(-[a-z]*r[a-z]*f|\/s\b|\/q\b)/i,
      /\bremove-item\b[^|;]*-recurse/i,
      /\bformat(-volume)?\b/i,
      /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)/i,
      /\b(shutdown|restart-computer|stop-computer)\b/i,
      /\bstop-process\b[^|;]*-force/i,
      /\bdd\b[^|;]*\bof=/i,
    ],
  },
  {
    classe: 'rede',
    padroes: [
      /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|scp|ftp|ssh)\b/i,
      /\bnpm\s+(install|i|publish|update)\b/i,
      /\b(pip|pnpm|yarn)\s+install\b/i,
      /\bgit\s+(clone|fetch|pull|push)\b/i,
      /\bdocker\s+(pull|push|run)\b/i,
    ],
  },
  {
    classe: 'escrita',
    padroes: [
      /\b(mkdir|new-item|copy|cp|move|mv|ren|rename-item|set-content|add-content|out-file)\b/i,
      /\b(rm|del|remove-item|erase)\b/i,
      />{1,2}[^>]/,
      /\bgit\s+(add|commit|checkout|switch|merge|rebase|stash)\b/i,
    ],
  },
  {
    classe: 'execucao',
    padroes: [
      /\b(npm|npx|node|python|py|pwsh|powershell|cmd|bash|sh|dotnet|cargo|go|java|make)\b/i,
      /\bstart-process\b/i,
      /\bdocker\b/i,
    ],
  },
];

// Leitura reconhecida como pura. Hoje serve apenas para rotular o comando na
// auditoria e na tela de aprovacao: NAO existe caminho automatico de execucao
// (ver `decide`). Precisa casar o comando INTEIRO.
const LEITURA_SEGURA = [
  /^(ls|dir|get-childitem|gci)(\s+[^|;&><]*)?$/i,
  /^(pwd|get-location|cd)(\s+[^|;&><]*)?$/i,
  /^(cat|type|get-content)\s+[^|;&><]+$/i,
  /^git\s+(status|log|diff|branch|show|remote)(\s+[^|;&><]*)?$/i,
  /^(node|npm|python|py|git)\s+(-v|--version|version)$/i,
  /^echo\s+[^|;&><]*$/i,
  /^(whoami|hostname|date|get-date)$/i,
];

function classify(command) {
  const texto = String(command || '').trim();
  for (const { classe, padroes } of CLASSES) {
    if (padroes.some((p) => p.test(texto))) return classe;
  }
  return 'leitura';
}

// Encadeamento e substituicao permitem esconder um comando perigoso dentro
// de um aparentemente inofensivo: `ls; rm -rf /` classificaria pela primeira
// parte se olhassemos so' o inicio.
function hasChaining(command) {
  return /[;&|]|\$\(|`|\bstart-job\b/i.test(String(command || ''));
}

function isSafeRead(command) {
  const texto = String(command || '').trim();
  if (hasChaining(texto)) return false;
  return LEITURA_SEGURA.some((p) => p.test(texto));
}

/**
 * Classifica o comando e decide se ele pode rodar.
 *
 * `allowSafeReads` nasce desligado e nao e' ligado por nenhum chamador: todo
 * `terminal_run` exige aprovacao humana. A allowlist casava o texto do
 * comando, mas texto nao prova efeito — `cat` e `git log` aceitam caminhos
 * absolutos e recebem argumentos escritos pelo modelo a partir de conteudo
 * nao confiavel (chat, RAG, web, arquivos), e o shell resolve variaveis de
 * ambiente e wildcards depois que a regex ja' aprovou a string. Enquanto os
 * caminhos e efeitos de um comando nao estiverem comprovadamente confinados
 * ao workspace, a aprovacao humana e' a unica fronteira que sustenta a
 * afirmacao "um comando nao escapa silenciosamente do escopo autorizado".
 */
function decide(command, { allowSafeReads = false } = {}) {
  const texto = String(command || '').trim();
  if (!texto) return { permitido: false, motivo: 'Comando vazio.', classe: 'leitura', exigeAprovacao: true };
  if (texto.length > MAX_COMMAND_LENGTH) {
    return { permitido: false, motivo: 'Comando acima do limite de tamanho.', classe: 'leitura', exigeAprovacao: true };
  }
  const classe = classify(texto);
  const encadeado = hasChaining(texto);
  const automatico = allowSafeReads && isSafeRead(texto);
  return {
    permitido: true,
    classe,
    encadeado,
    exigeAprovacao: !automatico,
    motivo: automatico ? 'Leitura reconhecida na allowlist.' : `Classe ${classe}: exige aprovação.`,
  };
}

// O processo do Electron carrega OLLAMA_API_KEY, JARVIS_TAVILY_API_KEY e o
// token do backend. Herdar tudo entregaria esses segredos a qualquer
// comando. Montamos um ambiente minimo com o que um shell precisa.
const ENV_BASE = [
  'PATH', 'Path', 'SystemRoot', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
  'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE',
];

// Uma CLI de agente (Claude Code, Codex, Antigravity) precisa de mais que um
// shell: ela le' a credencial que o usuario ja' configurou interativamente,
// guardada no perfil do Windows (%APPDATA%, %LOCALAPPDATA%, ~/.claude,
// ~/.codex) ou no cofre do sistema. Sem essas variaveis a CLI cai em "nao
// autenticado" e a delegacao para de funcionar. O que continua de fora e' o
// que interessa a um atacante: chaves do JARVIS, do Ollama, do Tavily e o
// token do backend local — nenhuma delas serve para autenticar essas CLIs.
const ENV_DELEGACAO = [
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'SystemDrive', 'USERNAME', 'USERDOMAIN', 'PUBLIC', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'LANG', 'LC_ALL', 'TZ',
];

function pickEnv(chaves) {
  const env = {};
  for (const chave of chaves) {
    if (process.env[chave] !== undefined) env[chave] = process.env[chave];
  }
  return env;
}

function sanitizedEnv() {
  return pickEnv(ENV_BASE);
}

/** Ambiente para delegar a uma CLI de agente, sem herdar segredos do JARVIS. */
function delegateEnv() {
  return { ...pickEnv(ENV_BASE), ...pickEnv(ENV_DELEGACAO) };
}

// No Windows, matar o pai deixa os filhos rodando. taskkill /T percorre a
// arvore inteira; sem isso, um `npm test` cancelado deixaria node orfao.
function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* ja' morreu */ }
      resolve();
      return;
    }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

// Um comando aprovado pelo usuario pode carregar credencial no proprio texto
// (`curl -H "Authorization: Bearer ..."`, `$env:OPENAI_API_KEY="sk-..."`,
// `git clone https://user:senha@host/repo`). A auditoria e' um arquivo em
// texto puro que sobrevive a reinicializacao: gravar o comando cru
// transformaria o registro de seguranca num deposito de segredos. Redigimos
// o VALOR e preservamos a forma, para o registro continuar legivel.
const PADROES_SEGREDO = [
  // Atribuicao a variavel/flag com nome sugestivo, com ou sem aspas.
  [/((?:api[-_]?key|apikey|secret|token|password|passwd|pwd|senha|credential)\s*[:=]\s*)(["']?)([^\s"';|&]+)\2/gi, '$1$2[REDIGIDO]$2'],
  // Cabecalho de autorizacao.
  [/((?:authorization|auth|proxy-authorization)\s*:\s*(?:bearer|basic|token)?\s*)([^\s"';|&]+)/gi, '$1[REDIGIDO]'],
  // Credencial embutida em URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, '$1$2:[REDIGIDO]@'],
  // Formatos de chave reconheciveis por prefixo, mesmo soltos no comando.
  [/\b(sk|pk|rk|tvly|ghp|gho|ghu|ghs|ghr|github_pat|npm|xox[baprs]|AKIA|ASIA|glpat|dop_v1|shpat)[-_][A-Za-z0-9_-]{8,}/g, '[REDIGIDO]'],
  // Flags de linha de comando que recebem o segredo como proximo argumento.
  [/(--(?:token|password|api-key|apikey|secret)|--with-token)(?:\s+|=)(["']?)([^\s"';|&]+)\3/gi, '$1=$2[REDIGIDO]$2'],
];

function redactSecrets(texto) {
  let saida = String(texto ?? '');
  for (const [padrao, substituto] of PADROES_SEGREDO) saida = saida.replace(padrao, substituto);
  return saida;
}

async function appendAudit(registro) {
  try {
    await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true });
    await fs.appendFile(AUDIT_PATH, `${JSON.stringify(registro)}\n`, 'utf8');
  } catch {
    // Auditoria nunca pode derrubar a execucao que ela observa.
  }
}

async function readAudit(limite = 100) {
  try {
    const bruto = await fs.readFile(AUDIT_PATH, 'utf8');
    return bruto.split('\n').filter(Boolean).slice(-limite).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Executa um comando ja' autorizado, com ambiente saneado, limite de saida,
 * timeout e encerramento da arvore de processos.
 */
async function runCommand(command, {
  cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, decisao, onOutput, onStarted,
} = {}) {
  const inicio = Date.now();
  const resultado = await new Promise((resolve) => {
    const filho = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { cwd, env: sanitizedEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    onStarted?.({ pid: filho.pid, cwd: path.resolve(cwd) });

    let stdout = '';
    let stderr = '';
    let encerrado = null;

    const finalizar = async (motivo) => {
      if (encerrado) return;
      encerrado = motivo;
      await killTree(filho.pid);
    };

    const timer = setTimeout(() => finalizar('timeout'), timeoutMs);
    const aoAbortar = () => finalizar('cancelado');
    signal?.addEventListener('abort', aoAbortar, { once: true });

    filho.stdout.on('data', (c) => {
      const chunk = c.toString();
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; else finalizar('saida-excedida');
      onOutput?.('stdout', chunk);
    });
    filho.stderr.on('data', (c) => {
      const chunk = c.toString();
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; else finalizar('saida-excedida');
      onOutput?.('stderr', chunk);
    });

    filho.on('error', (erro) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aoAbortar);
      resolve({ stdout, stderr: String(erro.message), exitCode: -1, status: 'erro' });
    });
    filho.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aoAbortar);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        status: encerrado || (code === 0 ? 'ok' : 'falha'),
      });
    });
  });

  const duracaoMs = Date.now() - inicio;
  await appendAudit({
    quando: new Date().toISOString(),
    comando: redactSecrets(String(command)).slice(0, 500),
    classe: decisao?.classe || classify(command),
    aprovacao: decisao?.exigeAprovacao ? 'aprovada' : 'automatica',
    status: resultado.status,
    exitCode: resultado.exitCode,
    duracaoMs,
  });

  return { ...resultado, duracaoMs };
}

module.exports = {
  AUDIT_PATH,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  appendAudit,
  assertBypassCommandAllowed,
  classify,
  decide,
  delegateEnv,
  hasChaining,
  isSafeRead,
  killTree,
  readAudit,
  redactSecrets,
  runCommand,
  sanitizedEnv,
};
