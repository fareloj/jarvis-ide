const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow;
let backend;
const activeChatRequests = new Map();

function loadEnvironment() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#e2e0e0',
    frame: false,
    show: false,
    title: 'JARVIS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function registerIpc() {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() || false);

  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Abrir projeto no JARVIS',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const projectPath = result.filePaths[0];
    return { path: projectPath, name: path.basename(projectPath) };
  });

  ipcMain.handle('backend:health', async () => {
    const response = await fetch(`${backend.url}/health`);
    return response.json();
  });
  ipcMain.handle('backend:chat', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao conversar com o modelo.');
    return data;
  });

  ipcMain.on('backend:chat-stream', async (event, { requestId, payload } = {}) => {
    if (!requestId || activeChatRequests.has(requestId)) return;
    const abortController = new AbortController();
    activeChatRequests.set(requestId, abortController);

    const emit = (streamEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('backend:chat-event', { requestId, event: streamEvent });
      }
    };

    try {
      const response = await fetch(`${backend.url}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Falha ao conversar com o modelo.');
      }

      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) emit(JSON.parse(line));
        }
      }
      if (pending.trim()) emit(JSON.parse(pending));
    } catch (error) {
      if (error?.name === 'AbortError') emit({ type: 'cancelled' });
      else emit({ type: 'error', error: error?.message || 'Falha inesperada no streaming.' });
    } finally {
      activeChatRequests.delete(requestId);
    }
  });

  ipcMain.handle('backend:chat-cancel', (_event, requestId) => {
    const controller = activeChatRequests.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  });
}

app.whenReady().then(async () => {
  loadEnvironment();
  const { startBackend } = require('../backend/server');
  backend = await startBackend();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const controller of activeChatRequests.values()) controller.abort();
  activeChatRequests.clear();
  backend?.server?.close();
  if (process.platform !== 'darwin') app.quit();
});
