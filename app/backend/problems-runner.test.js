const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {
  ProblemsRunner,
  parseDiagnosticLine,
  sanitizeProblemsEnv,
  normalizeProblemPath,
} = require('./problems-runner');

test('sanitizeProblemsEnv remove segredos e chaves de API mas preserva variáveis de sistema', () => {
  const custom = {
    OLLAMA_API_KEY: 'segredo123',
    TAVILY_API_KEY: 'segredo456',
    MY_SECRET_TOKEN: 'token789',
    PATH: 'C:\\Windows\\system32',
    NODE_ENV: 'production',
  };
  const env = sanitizeProblemsEnv(custom);
  assert.equal(env.OLLAMA_API_KEY, undefined);
  assert.equal(env.TAVILY_API_KEY, undefined);
  assert.equal(env.MY_SECRET_TOKEN, undefined);
  assert.ok(env.PATH || env.Path);
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.TERM, 'xterm-256color');
});

test('parseDiagnosticLine extrai diagnósticos TypeScript e ESLint', () => {
  // TypeScript format
  const line1 = 'src/app.ts(42,15): error TS2304: Cannot find name "usuario".';
  const diag1 = parseDiagnosticLine(line1);
  assert.ok(diag1);
  assert.equal(diag1.path, 'src/app.ts');
  assert.equal(diag1.line, 42);
  assert.equal(diag1.column, 15);
  assert.equal(diag1.severity, 'error');
  assert.equal(diag1.code, 'TS2304');
  assert.ok(diag1.message.includes('Cannot find name'));

  // Colon format
  const line2 = 'src/components/Header.js:10:8: warning: Variable "x" is never used';
  const diag2 = parseDiagnosticLine(line2);
  assert.ok(diag2);
  assert.equal(diag2.path, 'src/components/Header.js');
  assert.equal(diag2.line, 10);
  assert.equal(diag2.column, 8);
  assert.equal(diag2.severity, 'warning');
  assert.ok(diag2.message.includes('Variable "x" is never used'));

  // Node.js test runner format
  const line3 = '✖ o teste de autenticação falhou (backend/auth.test.js:15:3)';
  const diag3 = parseDiagnosticLine(line3);
  assert.ok(diag3);
  assert.equal(diag3.path, 'backend/auth.test.js');
  assert.equal(diag3.line, 15);
  assert.equal(diag3.column, 3);
  assert.equal(diag3.severity, 'error');
  assert.ok(diag3.message.includes('o teste de autenticação falhou'));
});

test('normalizeProblemPath remove prefixo absoluto do workspace', () => {
  const root = 'C:/Users/danie/Documents/JARVIS_2';
  assert.equal(
    normalizeProblemPath('C:/Users/danie/Documents/JARVIS_2/src/app.js', root),
    'src/app.js'
  );
  assert.equal(
    normalizeProblemPath('src/components/Header.js', root),
    'src/components/Header.js'
  );
});

test('runDiagnostics executa comando e reporta problemas encontrados', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-problems-test-'));
  t.after(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  const testScript = 'src/test-fail.js(12,4): error TS1005: ";" expected.\nsrc/warn.js:5:2: warning: unused variable';
  const runner = new ProblemsRunner({
    resolveCommand: async () => ({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(testScript)})`],
      label: 'internal-test-diagnostics',
    }),
  });

  const result = await runner.runDiagnostics({
    projectPath: tempDir,
  });

  assert.equal(result.status, 'success');
  assert.ok(result.problems.length >= 2);
  assert.equal(result.totalErrors, 1);
  assert.equal(result.totalWarnings, 1);

  const p1 = result.problems.find((p) => p.path === 'src/test-fail.js');
  assert.ok(p1);
  assert.equal(p1.line, 12);
  assert.equal(p1.column, 4);
  assert.equal(p1.severity, 'error');
});

test('runDiagnostics aplica timeout e encerra o processo se exceder tempo', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-problems-timeout-'));
  t.after(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  const runner = new ProblemsRunner({
    resolveCommand: async () => ({ executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], label: 'slow-test' }),
  });

  const result = await runner.runDiagnostics({
    projectPath: tempDir,
    timeoutMs: 1000,
  });

  assert.equal(result.status, 'timeout');
});

test('cancelRun interrompe a execução do diagnóstico', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-problems-cancel-'));
  t.after(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  const runner = new ProblemsRunner({
    resolveCommand: async () => ({ executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], label: 'slow-test' }),
  });

  const runPromise = runner.runDiagnostics({
    projectPath: tempDir,
    runId: 'prob-cancel-test-1234',
    timeoutMs: 15000,
  });

  // Aguarda iniciar
  await new Promise((r) => setTimeout(r, 200));
  const activeRuns = Array.from(runner.activeRuns.keys());
  assert.ok(activeRuns.length > 0);

  const cancelled = await runner.cancelRun(activeRuns[0]);
  assert.equal(cancelled, true);

  const result = await runPromise;
  assert.ok(result.durationMs < 5000);
  assert.equal(result.status, 'cancelled');
});

test('ignora comando arbitrário vindo do renderer e executa somente resolução interna', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-problems-injection-'));
  const marker = path.join(tempDir, 'pwned.txt');
  t.after(async () => fs.rm(tempDir, { recursive: true, force: true }).catch(() => {}));

  const runner = new ProblemsRunner({
    resolveCommand: async () => ({ executable: process.execPath, args: ['-e', 'process.exit(0)'], label: 'safe-check' }),
  });
  const malicious = process.platform === 'win32'
    ? `echo pwned>"${marker}"`
    : `touch "${marker}"`;
  const result = await runner.runDiagnostics({ projectPath: tempDir, command: malicious });

  assert.equal(result.status, 'success');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(result.command, 'safe-check');
});
