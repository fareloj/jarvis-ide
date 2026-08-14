// Executor de diagnósticos e painel Problems.
//
// Executa verificações de lint, testes e compilação em ambiente saneado,
// com timeout estrito, cancelamento com encerramento de árvore de processos
// e limites rígidos de saída para alimentar o painel Problems da IDE.

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 100_000; // 100 KB
const MAX_OUTPUT_LINES = 1_000;

// Allowlist estrita de variáveis de ambiente seguras
const ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'NODE_ENV',
  'TERM',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'ProgramFiles',
  'PROGRAMDATA',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'OS',
]);

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /auth/i,
  /bearer/i,
  /credential/i,
  /private[_-]?key/i,
  /ollama/i,
  /gemini/i,
  /anthropic/i,
  /openai/i,
  /tavily/i,
  /serper/i,
  /brave/i,
];

function sanitizeProblemsEnv(extraEnv = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ALLOWED_ENV_KEYS.has(k)) {
      const isSecret = SECRET_PATTERNS.some((pat) => pat.test(k));
      if (!isSecret) env[k] = v;
    }
  }
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (ALLOWED_ENV_KEYS.has(k)) {
      const isSecret = SECRET_PATTERNS.some((pat) => pat.test(k));
      if (!isSecret) env[k] = v;
    }
  }
  env.NODE_ENV = env.NODE_ENV || 'test';
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* processo finalizado */ }
      }
      return resolve();
    }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

/**
 * Parsers de linha para extrair diagnósticos estruturados de linters/testes/compiladores.
 */
function parseDiagnosticLine(rawLine, rootPath = '') {
  const line = rawLine.trim();
  if (!line) return null;

  // 1. TypeScript / GCC / MSBuild: `path/file.ts(10,5): error TS2304: Cannot find name 'x'.`
  const tsParenMatch = line.match(/^([a-zA-Z0-9_./\\-]+)\((\d+),(\d+)\):\s*(error|warning|info)\s+([A-Za-z0-9]+)?:\s*(.+)$/i);
  if (tsParenMatch) {
    return {
      path: normalizeProblemPath(tsParenMatch[1], rootPath),
      line: Number(tsParenMatch[2]),
      column: Number(tsParenMatch[3]),
      severity: tsParenMatch[4].toLowerCase(),
      code: tsParenMatch[5] || null,
      message: tsParenMatch[6],
      source: 'tsc',
      rawLine,
    };
  }

  // 2. ESLint / Rust / Clang / GCC: `path/file.js:10:5: error: message` or `path/file.js:10:5 - error TS2304: message`
  const colonMatch = line.match(/^([a-zA-Z0-9_./\\-]+):(\d+):(\d+)(?::\s*|\s*-\s*)(error|warning|info)?(?:\s+([A-Za-z0-9]+)?:)?\s*(.+)$/i);
  if (colonMatch) {
    return {
      path: normalizeProblemPath(colonMatch[1], rootPath),
      line: Number(colonMatch[2]),
      column: Number(colonMatch[3]),
      severity: (colonMatch[4] || 'error').toLowerCase(),
      code: colonMatch[5] || null,
      message: colonMatch[6],
      source: 'linter',
      rawLine,
    };
  }

  // 3. Node.js test runner / Jest: `✖ test name (path/file.test.js:10:5)`
  const nodeTestMatch = line.match(/^✖\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/);
  if (nodeTestMatch) {
    return {
      path: normalizeProblemPath(nodeTestMatch[2], rootPath),
      line: Number(nodeTestMatch[3]),
      column: Number(nodeTestMatch[4]),
      severity: 'error',
      code: 'TEST_FAIL',
      message: `Falha no teste: ${nodeTestMatch[1]}`,
      source: 'test-runner',
      rawLine,
    };
  }

  // 4. Python flake8 / pylint / pytest: `path/file.py:10: [E999] message`
  const pyMatch = line.match(/^([a-zA-Z0-9_./\\-]+):(\d+):\s*(?:\[([A-Z0-9]+)\]\s*)?(.+)$/i);
  if (pyMatch && !line.startsWith('http') && !line.startsWith('at ')) {
    return {
      path: normalizeProblemPath(pyMatch[1], rootPath),
      line: Number(pyMatch[2]),
      column: 1,
      severity: 'error',
      code: pyMatch[3] || null,
      message: pyMatch[4],
      source: 'python',
      rawLine,
    };
  }

  // 5. Node.js stack trace line: `at Object.<anonymous> (C:\path\file.js:10:5)`
  const stackMatch = line.match(/^at\s+(?:.+?\s+\()?([a-zA-Z]:[\\/][^:]+|\/[^:]+|[a-zA-Z0-9_./\\-]+):(\d+):(\d+)\)?$/);
  if (stackMatch) {
    return {
      path: normalizeProblemPath(stackMatch[1], rootPath),
      line: Number(stackMatch[2]),
      column: Number(stackMatch[3]),
      severity: 'error',
      code: 'STACK',
      message: line,
      source: 'runtime',
      rawLine,
    };
  }

  return null;
}

function normalizeProblemPath(rawFilePath, rootPath = '') {
  let p = rawFilePath.replace(/\\/g, '/');
  if (rootPath) {
    const normRoot = rootPath.replace(/\\/g, '/').replace(/\/$/, '');
    if (p.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
      p = p.slice(normRoot.length + 1);
    }
  }
  return p;
}

class ProblemsRunner {
  constructor({ resolveCommand = null } = {}) {
    this.activeRuns = new Map(); // runId -> { pid, abortController, status }
    this.resolveCommand = resolveCommand;
  }

  async detectDefaultCheckCommand(projectPath) {
    const pkgPath = path.join(projectPath, 'package.json');
    try {
      const data = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      const scripts = data.scripts || {};
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      if (scripts.check) return { executable: npm, args: ['run', 'check'], label: 'npm run check' };
      if (scripts.lint) return { executable: npm, args: ['run', 'lint'], label: 'npm run lint' };
      if (scripts.test) return { executable: npm, args: ['test'], label: 'npm test' };
    } catch {
      // Ignora ausência de package.json
    }

    // Outros ecossistemas
    try {
      await fs.stat(path.join(projectPath, 'Cargo.toml'));
      return { executable: 'cargo', args: ['check'], label: 'cargo check' };
    } catch {}

    try {
      await fs.stat(path.join(projectPath, 'go.mod'));
      return { executable: 'go', args: ['vet', './...'], label: 'go vet ./...' };
    } catch {}

    try {
      await fs.stat(path.join(projectPath, 'pytest.ini'));
      return { executable: 'pytest', args: [], label: 'pytest' };
    } catch {}

    return { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'], label: 'npm test' };
  }

  async runDiagnostics({
    projectPath,
    runId: requestedRunId = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    extraEnv = {},
  } = {}) {
    const raiz = path.resolve(String(projectPath || ''));
    if (!raiz || raiz === '.') throw new Error('Nenhum projeto aberto para executar diagnósticos.');

    const runId = requestedRunId || `prob-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (!/^prob-[A-Za-z0-9_-]{8,120}$/.test(runId)) throw new Error('Identificador de diagnóstico inválido.');
    if (this.activeRuns.has(runId)) throw new Error('Já existe um diagnóstico com este identificador.');

    const runEntry = { runId, pid: null, command: null, status: 'starting' };
    this.activeRuns.set(runId, runEntry);
    let descriptor;
    try {
      descriptor = this.resolveCommand
        ? await this.resolveCommand(raiz)
        : await this.detectDefaultCheckCommand(raiz);
    } catch (error) {
      this.activeRuns.delete(runId);
      throw error;
    }
    if (!descriptor || typeof descriptor.executable !== 'string' || !Array.isArray(descriptor.args)) {
      this.activeRuns.delete(runId);
      throw new Error('Comando de diagnóstico interno inválido.');
    }
    const commandLabel = descriptor.label || [descriptor.executable, ...descriptor.args].join(' ');
    const effectiveTimeout = Math.max(1000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

    const env = sanitizeProblemsEnv(extraEnv);
    const abortController = new AbortController();

    return new Promise((resolve) => {
      const startTime = Date.now();
      let outputBuffer = '';
      let truncated = false;
      let killedDueToTimeout = false;

      const child = spawn(descriptor.executable, descriptor.args, {
        shell: false,
        cwd: raiz,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      runEntry.pid = child.pid;
      runEntry.command = commandLabel;
      runEntry.abortController = abortController;
      if (runEntry.status === 'cancelled') void killTree(child.pid);
      else runEntry.status = 'running';

      const timer = setTimeout(async () => {
        killedDueToTimeout = true;
        runEntry.status = 'timeout';
        await killTree(child.pid);
      }, effectiveTimeout);

      const appendOutput = (chunk) => {
        if (outputBuffer.length < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - outputBuffer.length;
          outputBuffer += chunk.toString('utf8').slice(0, remaining);
        } else {
          truncated = true;
        }
      };

      child.stdout.on('data', appendOutput);
      child.stderr.on('data', appendOutput);

      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        this.activeRuns.delete(runId);
        const durationMs = Date.now() - startTime;

        const lines = outputBuffer.split(/\r?\n/).slice(0, MAX_OUTPUT_LINES);
        const problems = [];
        const seen = new Set();

        for (const line of lines) {
          const diag = parseDiagnosticLine(line, raiz);
          if (diag) {
            const key = `${diag.path}:${diag.line}:${diag.column}:${diag.message}`;
            if (!seen.has(key)) {
              seen.add(key);
              problems.push(diag);
            }
          }
        }

        const totalErrors = problems.filter((p) => p.severity === 'error').length;
        const totalWarnings = problems.filter((p) => p.severity === 'warning').length;
        const totalInfos = problems.filter((p) => p.severity === 'info').length;

        resolve({
          runId,
          command: commandLabel,
          exitCode: exitCode ?? (killedDueToTimeout ? -1 : 0),
          signal: signal || null,
          durationMs,
          problems,
          totalErrors,
          totalWarnings,
          totalInfos,
          status: killedDueToTimeout ? 'timeout' : runEntry.status === 'cancelled' ? 'cancelled' : exitCode === 0 ? 'success' : 'failed',
          rawOutput: outputBuffer,
          truncated,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeRuns.delete(runId);
        resolve({
          runId,
          command: commandLabel,
          exitCode: -1,
          signal: null,
          durationMs: Date.now() - startTime,
          problems: [{
            path: 'workspace',
            line: 1,
            column: 1,
            severity: 'error',
            code: 'SPAWN_ERROR',
            message: `Falha ao iniciar comando: ${err.message}`,
            source: 'runner',
            rawLine: err.message,
          }],
          totalErrors: 1,
          totalWarnings: 0,
          totalInfos: 0,
          status: 'error',
          rawOutput: err.message,
          truncated: false,
        });
      });
    });
  }

  async cancelRun(runId) {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    run.status = 'cancelled';
    if (run.pid) {
      await killTree(run.pid);
    }
    return true;
  }
}

const defaultProblemsRunner = new ProblemsRunner();

module.exports = {
  ProblemsRunner,
  defaultProblemsRunner,
  parseDiagnosticLine,
  sanitizeProblemsEnv,
  normalizeProblemPath,
  killTree,
};
