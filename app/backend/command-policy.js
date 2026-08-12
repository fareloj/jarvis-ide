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

// Leitura pura: seguro o bastante para dispensar aprovacao caso a politica
// de allowlist esteja ligada. Precisa casar o comando INTEIRO.
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
 * Decide se o comando pode rodar sem aprovacao.
 * Por padrao tudo exige aprovacao; a allowlist so' libera leitura pura.
 */
function decide(command, { allowSafeReads = true } = {}) {
  const texto = String(command || '').trim();
  if (!texto) return { permitido: false, motivo: 'Comando vazio.', classe: 'leitura', exigeAprovacao: true };
  if (texto.length > MAX_COMMAND_LENGTH) {
    return { permitido: false, motivo: 'Comando acima do limite de tamanho.', classe: 'leitura', exigeAprovacao: true };
  }
  const classe = classify(texto);
  const encadeado = hasChaining(texto);
  // A allowlist e' quem decide o modo automatico, nao a classe: ela exige
  // casamento do comando inteiro e ja' recusa encadeamento. O classificador
  // e' amplo de proposito (marca `node --version` como execucao) e serve
  // para rotular e auditar, nao para liberar.
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
function sanitizedEnv() {
  const permitidas = ['PATH', 'Path', 'SystemRoot', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE'];
  const env = {};
  for (const chave of permitidas) {
    if (process.env[chave] !== undefined) env[chave] = process.env[chave];
  }
  return env;
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
async function runCommand(command, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, decisao } = {}) {
  const inicio = Date.now();
  const resultado = await new Promise((resolve) => {
    const filho = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { cwd, env: sanitizedEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

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

    filho.stdout.on('data', (c) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += c; else finalizar('saida-excedida'); });
    filho.stderr.on('data', (c) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += c; else finalizar('saida-excedida'); });

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
    comando: String(command).slice(0, 500),
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
  classify,
  decide,
  hasChaining,
  isSafeRead,
  killTree,
  readAudit,
  runCommand,
  sanitizedEnv,
};
