const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const pty = require('node-pty');

/**
 * Encerra toda a árvore de processos a partir do PID informado.
 * No Windows, usa taskkill /T /F para impedir processos filhos ou netos órfãos.
 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* processo já finalizado */ }
      }
      return resolve();
    }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

function resolveDefaultShell() {
  if (process.platform === 'win32') {
    // PowerShell é o padrão preferencial no Windows; fallback para cmd.exe.
    const powershellPath = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    if (fs.existsSync(powershellPath)) return powershellPath;
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function resolveWorkingDir(solicitado) {
  if (solicitado && typeof solicitado === 'string') {
    try {
      const resolvido = path.resolve(solicitado);
      if (fs.existsSync(resolvido) && fs.statSync(resolvido).isDirectory()) {
        return resolvido;
      }
    } catch {
      // Ignora erro e usa pasta padrão
    }
  }
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}

function sanitizePtyEnv(extraEnv = {}) {
  // Constrói ambiente seguro herdando variáveis de sistema essenciais (PATH, TEMP, USERNAME, etc.)
  const permitidas = [
    'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir',
    'USERPROFILE', 'HOME', 'HOMEPATH', 'HOMEDRIVE', 'USERNAME', 'USER', 'LOGNAME',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData', 'PROGRAMFILES', 'ProgramFiles',
    'COMSPEC', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'COLORTERM',
  ];
  const env = {};
  for (const chave of permitidas) {
    if (process.env[chave] !== undefined) env[chave] = process.env[chave];
  }
  if (!env.TERM) env.TERM = 'xterm-256color';
  if (!env.COLORTERM) env.COLORTERM = 'truecolor';

  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

async function disposePtyResources(session) {
  for (const disposable of session?.disposables || []) {
    try { disposable?.dispose?.(); } catch { /* noop */ }
  }
  const agent = session?.process?._agent;
  const conoutConnection = agent?._conoutSocketWorker;
  const conoutWorker = conoutConnection?._worker;
  try { conoutConnection?.dispose?.(); } catch { /* noop */ }
  try { await conoutWorker?.terminate?.(); } catch { /* noop */ }
  try { agent?._inSocket?.destroy?.(); } catch { /* noop */ }
  try { agent?._outSocket?.destroy?.(); } catch { /* noop */ }
  try { session?.process?._inSocket?.destroy?.(); } catch { /* noop */ }
  try { session?.process?._outSocket?.destroy?.(); } catch { /* noop */ }
  try { session?.process?._socket?.destroy?.(); } catch { /* noop */ }
}

class PtyManager {
  constructor() {
    this.sessions = new Map();
  }

  /**
   * Cria uma nova sessão interativa de PTY vinculada a uma janela.
   */
  createSession({
    cwd,
    cols = 80,
    rows = 24,
    windowId = null,
    shell = null,
    args = [],
    env = {},
    onData = null,
    onExit = null,
  } = {}) {
    const sessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const shellPath = shell || resolveDefaultShell();
    const workingDir = resolveWorkingDir(cwd);
    const validCols = Math.max(10, Math.min(Number(cols) || 80, 500));
    const validRows = Math.max(5, Math.min(Number(rows) || 24, 200));

    const ptyProcess = pty.spawn(shellPath, args, {
      name: 'xterm-256color',
      cols: validCols,
      rows: validRows,
      cwd: workingDir,
      env: sanitizePtyEnv(env),
      useConpty: process.platform === 'win32' ? false : undefined,
    });

    const session = {
      id: sessionId,
      windowId,
      process: ptyProcess,
      pid: ptyProcess.pid,
      cwd: workingDir,
      shell: shellPath,
      cols: validCols,
      rows: validRows,
      createdAt: new Date().toISOString(),
      status: 'running',
      listeners: { onData, onExit },
    };

    const dataDisposable = ptyProcess.onData((data) => {
      if (session.status === 'running' && session.listeners.onData) {
        try { session.listeners.onData(data); } catch (e) { console.error('Erro em onData do PTY:', e); }
      }
    });

    const exitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
      session.status = 'exited';
      session.exitCode = exitCode;
      session.signal = signal;
      try { ptyProcess._socket?.unref?.(); } catch {}
      if (session.listeners.onExit) {
        try { session.listeners.onExit({ exitCode, signal }); } catch (e) { console.error('Erro em onExit do PTY:', e); }
      }
      this.sessions.delete(sessionId);
      void disposePtyResources(session);
    });

    session.disposables = [dataDisposable, exitDisposable];

    this.sessions.set(sessionId, session);

    return {
      sessionId,
      pid: session.pid,
      cwd: session.cwd,
      shell: shellPath,
      cols: session.cols,
      rows: session.rows,
    };
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  assertOwner(sessionId, windowId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') {
      throw new Error(`Sessão PTY ${sessionId} inexistente ou finalizada.`);
    }
    if (windowId === null || windowId === undefined || session.windowId !== windowId) {
      const error = new Error('A sessão PTY não pertence à janela solicitante.');
      error.code = 'PTY_OWNER_MISMATCH';
      throw error;
    }
    return session;
  }

  listSessions(windowId = null) {
    const list = [];
    for (const s of this.sessions.values()) {
      if (windowId === null || s.windowId === windowId) {
        list.push({
          id: s.id,
          windowId: s.windowId,
          pid: s.pid,
          cwd: s.cwd,
          shell: s.shell,
          cols: s.cols,
          rows: s.rows,
          status: s.status,
          createdAt: s.createdAt,
        });
      }
    }
    return list;
  }

  write(sessionId, data, windowId = undefined) {
    const session = windowId === undefined
      ? this.sessions.get(sessionId)
      : this.assertOwner(sessionId, windowId);
    if (!session || session.status !== 'running') throw new Error(`Sessão PTY ${sessionId} inexistente ou finalizada.`);
    session.process.write(String(data ?? ''));
    return true;
  }

  resize(sessionId, cols, rows, windowId = undefined) {
    const session = windowId === undefined
      ? this.sessions.get(sessionId)
      : this.assertOwner(sessionId, windowId);
    if (!session || session.status !== 'running') {
      return false;
    }
    const validCols = Math.max(10, Math.min(Number(cols) || 80, 500));
    const validRows = Math.max(5, Math.min(Number(rows) || 24, 200));
    session.cols = validCols;
    session.rows = validRows;
    session.process.resize(validCols, validRows);
    return true;
  }

  async killSession(sessionId, windowId = undefined) {
    const session = windowId === undefined
      ? this.sessions.get(sessionId)
      : this.assertOwner(sessionId, windowId);
    if (!session) return false;
    session.status = 'killed';
    this.sessions.delete(sessionId);
    try { session.process.kill(); } catch { /* noop */ }
    try { session.process._socket?.unref?.(); } catch { /* noop */ }
    if (session.pid) {
      await killTree(session.pid);
    }
    await disposePtyResources(session);
    return true;
  }

  async restartSession(sessionId, options = {}) {
    const oldSession = this.sessions.get(sessionId);
    if (oldSession && options.windowId !== undefined) this.assertOwner(sessionId, options.windowId);
    const windowId = oldSession?.windowId ?? options.windowId ?? null;
    const cwd = options.cwd || oldSession?.cwd;
    const cols = options.cols || oldSession?.cols || 80;
    const rows = options.rows || oldSession?.rows || 24;
    const onData = options.onData || oldSession?.listeners?.onData;
    const onExit = options.onExit || oldSession?.listeners?.onExit;

    if (oldSession) {
      await this.killSession(sessionId);
    }

    return this.createSession({
      cwd,
      cols,
      rows,
      windowId,
      onData,
      onExit,
      shell: options.shell,
      args: options.args,
    });
  }

  async disposeWindowSessions(windowId) {
    if (windowId === null || windowId === undefined) return;
    const toKill = [];
    for (const session of this.sessions.values()) {
      if (session.windowId === windowId) {
        toKill.push(session.id);
      }
    }
    await Promise.all(toKill.map((id) => this.killSession(id)));
  }

  async disposeAll() {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.killSession(id)));
  }
}

const defaultPtyManager = new PtyManager();

module.exports = {
  PtyManager,
  defaultPtyManager,
  killTree,
  sanitizePtyEnv,
};
