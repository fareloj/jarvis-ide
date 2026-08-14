const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { PtyManager, killTree, sanitizePtyEnv } = require('./pty-manager');
const { describeTools } = require('./tool-registry');

test('sanitizePtyEnv preserva caminhos do sistema e define TERM', () => {
  const env = sanitizePtyEnv({ MINHA_VAR: 'teste_val' });
  assert.equal(env.MINHA_VAR, 'teste_val');
  assert.ok(env.PATH || env.Path);
  assert.equal(env.TERM, 'xterm-256color');
});

test('cria uma sessão de PTY e recebe dados reais do processo', async (t) => {
  const manager = new PtyManager();
  t.after(async () => {
    await manager.disposeAll();
  });

  let output = '';
  let exitData = null;

  const shellCmd = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/c', 'echo PTY_TEST_OUTPUT_123'] : ['-c', 'echo PTY_TEST_OUTPUT_123'];

  const sessionInfo = manager.createSession({
    shell: shellCmd,
    args,
    cols: 80,
    rows: 24,
    windowId: 1,
    onData: (d) => { output += d; },
    onExit: (e) => { exitData = e; },
  });

  assert.ok(sessionInfo.sessionId);
  assert.ok(sessionInfo.pid > 0);

  // Aguarda até o processo finalizar e emitir os dados
  const start = Date.now();
  while (!exitData && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.ok(output.includes('PTY_TEST_OUTPUT_123'), `Esperava saída com PTY_TEST_OUTPUT_123, obteve: ${output}`);
  await manager.killSession(sessionInfo.sessionId);
  await manager.disposeAll();
});

test('escreve comandos interativos e redimensiona a sessão PTY', async (t) => {
  const manager = new PtyManager();
  t.after(async () => {
    await manager.disposeAll();
  });

  let output = '';
  const sessionInfo = manager.createSession({
    cols: 80,
    rows: 24,
    windowId: 10,
    onData: (d) => { output += d; },
  });

  assert.equal(manager.listSessions(10).length, 1);

  // Redimensiona
  const resized = manager.resize(sessionInfo.sessionId, 120, 40);
  assert.equal(resized, true);
  const session = manager.getSession(sessionInfo.sessionId);
  assert.equal(session.cols, 120);
  assert.equal(session.rows, 40);

  // Escreve entrada
  manager.write(sessionInfo.sessionId, 'echo INTERACTIVE_ECHO_XYZ\r\n');

  const start = Date.now();
  while (!output.includes('INTERACTIVE_ECHO_XYZ') && Date.now() - start < 6000) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.ok(output.includes('INTERACTIVE_ECHO_XYZ'));
  await manager.killSession(sessionInfo.sessionId);
  assert.equal(manager.getSession(sessionInfo.sessionId), null);
  await manager.disposeAll();
});

test('encerra a árvore de processos ao matar a sessão', async (t) => {
  const manager = new PtyManager();
  t.after(async () => {
    await manager.disposeAll();
  });

  const sessionInfo = manager.createSession({
    cols: 80,
    rows: 24,
    windowId: 42,
  });

  const pid = sessionInfo.pid;
  assert.ok(pid > 0);

  // Mata a sessão
  const killed = await manager.killSession(sessionInfo.sessionId);
  assert.equal(killed, true);
  assert.equal(manager.getSession(sessionInfo.sessionId), null);
  await manager.disposeAll();
});

test('reinicia sessão recriando processo com opções anteriores', async (t) => {
  const manager = new PtyManager();
  t.after(async () => {
    await manager.disposeAll();
  });

  let out1 = '';
  let out2 = '';

  const s1 = manager.createSession({
    cols: 90,
    rows: 30,
    windowId: 77,
    onData: (d) => { out1 += d; },
  });

  const s2 = await manager.restartSession(s1.sessionId, {
    onData: (d) => { out2 += d; },
  });

  assert.notEqual(s1.sessionId, s2.sessionId);
  assert.equal(manager.getSession(s1.sessionId), null);
  assert.ok(manager.getSession(s2.sessionId));
  assert.equal(s2.cols, 90);
  assert.equal(s2.rows, 30);
  await manager.killSession(s2.sessionId);
  await manager.disposeAll();
});

test('disposeWindowSessions encerra apenas as sessões da janela correspondente', async (t) => {
  const manager = new PtyManager();
  t.after(async () => {
    await manager.disposeAll();
  });

  const sWin1_A = manager.createSession({ windowId: 1 });
  const sWin1_B = manager.createSession({ windowId: 1 });
  const sWin2 = manager.createSession({ windowId: 2 });

  assert.equal(manager.listSessions(1).length, 2);
  assert.equal(manager.listSessions(2).length, 1);

  await manager.disposeWindowSessions(1);

  assert.equal(manager.listSessions(1).length, 0);
  assert.equal(manager.listSessions(2).length, 1);
  assert.ok(manager.getSession(sWin2.sessionId));
  await manager.killSession(sWin2.sessionId);
  await manager.disposeAll();
});

test('o registro de tools do agente não tem acesso ao PTY do usuário', () => {
  const tools = describeTools();
  const toolNames = tools.map((t) => t.name);

  // As tools do agente não devem conter nenhuma tool de controle de PTY
  assert.ok(!toolNames.includes('pty_write'));
  assert.ok(!toolNames.includes('pty_read'));
  assert.ok(!toolNames.includes('pty_kill'));
  assert.ok(!toolNames.includes('pty_session'));

  // A execução de terminal do agente permanece estritamente mediada por terminal_run
  assert.ok(toolNames.includes('terminal_run'));
});

test('operações em sessões inválidas são tratadas com segurança', async () => {
  const manager = new PtyManager();
  assert.throws(() => manager.write('sessao-fantasma', 'dados'), /inexistente ou finalizada/);
  assert.equal(manager.resize('sessao-fantasma', 100, 30), false);
  assert.equal(await manager.killSession('sessao-fantasma'), false);
  assert.equal(manager.getSession('sessao-fantasma'), null);
});

test('operações PTY recusam acesso de outra janela', async (t) => {
  const manager = new PtyManager();
  t.after(async () => manager.disposeAll());
  const session = manager.createSession({ windowId: 101 });

  assert.throws(() => manager.write(session.sessionId, 'echo ataque\r\n', 202), { code: 'PTY_OWNER_MISMATCH' });
  assert.throws(() => manager.resize(session.sessionId, 100, 30, 202), { code: 'PTY_OWNER_MISMATCH' });
  await assert.rejects(manager.killSession(session.sessionId, 202), { code: 'PTY_OWNER_MISMATCH' });
  await assert.rejects(manager.restartSession(session.sessionId, { windowId: 202 }), { code: 'PTY_OWNER_MISMATCH' });

  assert.ok(manager.getSession(session.sessionId));
  assert.equal(await manager.killSession(session.sessionId, 101), true);
});

test('killTree encerra processos netos reais sem deixar órfãos', async (t) => {
  const tempFile = path.join(os.tmpdir(), `pty-child-alive-${Date.now()}.tmp`);
  const scriptPath = path.join(os.tmpdir(), `pty-spawn-child-${Date.now()}.js`);

  fs.writeFileSync(tempFile, 'alive', 'utf8');
  // Script que cria um filho neto que continua rodando e atualizando o arquivo
  fs.writeFileSync(
    scriptPath,
    `const { spawn } = require('child_process');
const fs = require('fs');
const sub = spawn(process.execPath, ['-e', 'setInterval(() => fs.writeFileSync("${tempFile.replace(/\\/g, '\\\\')}", "neto-vivo", "utf8"), 50); setTimeout(() => {}, 60000);'], {
  detached: false,
  stdio: 'ignore'
});
console.log('NETO_PID:' + sub.pid);
setTimeout(() => {}, 60000);
`,
    'utf8'
  );

  let netoPid = null;
  t.after(async () => {
    if (netoPid) await killTree(netoPid);
    try { fs.unlinkSync(tempFile); } catch {}
    try { fs.unlinkSync(scriptPath); } catch {}
  });

  const manager = new PtyManager();
  t.after(async () => {
    await manager.disposeAll();
  });

  let output = '';
  const session = manager.createSession({
    shell: process.execPath,
    args: [scriptPath],
    onData: (d) => { output += d; },
  });

  const start = Date.now();
  while (!output.includes('NETO_PID:') && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const match = output.match(/NETO_PID:(\d+)/);
  assert.ok(match, 'Deveria ter iniciado o processo neto');
  netoPid = Number(match[1]);
  assert.ok(netoPid > 0);

  // Mata a sessão PTY
  await manager.killSession(session.sessionId);

  const deadline = Date.now() + 5000;
  let netoVivo = true;
  while (netoVivo && Date.now() < deadline) {
    try { process.kill(netoPid, 0); } catch { netoVivo = false; }
    if (netoVivo) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(netoVivo, false, 'killSession deve encerrar também o processo neto');

  // Verifica que a sessão não existe mais no manager
  assert.equal(manager.getSession(session.sessionId), null);
  await manager.disposeAll();
});
