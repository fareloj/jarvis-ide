const { app, BrowserWindow, dialog, ipcMain, shell, session, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { EVENT_TYPES, createRunEvent } = require('../backend/protocol');

const OLLAMA_ORIGIN = 'https://ollama.com';
let loginWindow = null;

app.disableHardwareAcceleration();
// A pasta de cache em disco do Chromium tem dado "Acesso negado" nesta máquina
// (ver logs), o que faz o renderer servir index.html/styles.css antigos em vez
// de reler o arquivo. Desabilitar o cache HTTP evita esse tipo de tela presa.
app.commandLine.appendSwitch('disable-http-cache');

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

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

function quotaCookieFilePath() {
  return path.join(app.getPath('userData'), 'quota-session.enc');
}

function persistQuotaCookie(cookie) {
  try {
    const file = quotaCookieFilePath();
    if (!cookie) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(file, safeStorage.encryptString(cookie));
  } catch (error) {
    console.error('Falha ao salvar sessão da quota:', error);
  }
}

function loadPersistedQuotaCookie() {
  try {
    const file = quotaCookieFilePath();
    if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(fs.readFileSync(file));
  } catch (error) {
    console.error('Falha ao ler sessão salva da quota:', error);
    return '';
  }
}

async function buildOllamaCookieHeader() {
  const cookies = await session.defaultSession.cookies.get({ domain: 'ollama.com' });
  if (!cookies.length) return '';
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function submitQuotaCookie(cookie) {
  const response = await fetch(`${backend.url}/api/ollama/quota/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie }),
  });
  return response.json();
}

function closeLoginWindow() {
  if (!loginWindow) return;
  const toClose = loginWindow;
  loginWindow = null;
  if (!toClose.isDestroyed()) toClose.destroy();
}

function openQuotaLoginWindow() {
  return new Promise((resolve) => {
    if (loginWindow) { closeLoginWindow(); }

    loginWindow = new BrowserWindow({
      width: 480,
      height: 720,
      parent: mainWindow,
      modal: true,
      show: true,
      autoHideMenuBar: true,
      title: 'Entrar na Ollama Cloud',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    let settled = false;
    let checking = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      closeLoginWindow();
      resolve(result);
    };

    const tryCapture = async () => {
      if (checking || settled) return;
      checking = true;
      try {
        const cookieHeader = await buildOllamaCookieHeader();
        if (!cookieHeader) return;
        const data = await submitQuotaCookie(cookieHeader);
        if (data && data.source && data.source !== 'error' && data.source !== 'unconfigured') {
          persistQuotaCookie(cookieHeader);
          finish({ ok: true, data });
        }
      } catch (error) {
        console.error('Falha ao validar login da Ollama Cloud:', error);
      } finally {
        checking = false;
      }
    };

    loginWindow.webContents.on('did-navigate', tryCapture);
    loginWindow.webContents.on('did-navigate-in-page', tryCapture);
    loginWindow.webContents.on('did-finish-load', tryCapture);
    loginWindow.on('closed', () => {
      loginWindow = null;
      finish({ ok: false, cancelled: true });
    });

    loginWindow.loadURL(`${OLLAMA_ORIGIN}/settings`);
  });
}

const ATTACHMENT_IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
]);
const ATTACHMENT_TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsx', '.kt', '.md', '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.sql', '.svelte', '.toml', '.ts',
  '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.log',
]);
const ATTACHMENT_MAX_IMAGE_BYTES = 8_000_000;
const ATTACHMENT_MAX_TEXT_BYTES = 400_000;

// Lê um arquivo escolhido pelo usuário no diálogo nativo — diferente das
// tools do agente (project_read_file etc.), não fica confinado à pasta do
// projeto: o próprio diálogo do sistema já é o portão de permissão aqui.
function readAttachment(filePath) {
  const stat = fs.statSync(filePath);
  const name = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (!stat.isFile()) throw new Error('O caminho selecionado não é um arquivo.');

  if (ATTACHMENT_IMAGE_MIME.has(extension)) {
    if (stat.size > ATTACHMENT_MAX_IMAGE_BYTES) throw new Error('Imagem maior que 8 MB.');
    const buffer = fs.readFileSync(filePath);
    return {
      name, path: filePath, kind: 'image', size: stat.size,
      mime: ATTACHMENT_IMAGE_MIME.get(extension),
      base64: buffer.toString('base64'),
    };
  }
  if (ATTACHMENT_TEXT_EXTENSIONS.has(extension)) {
    if (stat.size > ATTACHMENT_MAX_TEXT_BYTES) throw new Error('Arquivo de texto maior que 400 KB.');
    return { name, path: filePath, kind: 'text', size: stat.size, content: fs.readFileSync(filePath, 'utf8') };
  }
  return { name, path: filePath, kind: 'binary', size: stat.size };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#e2e0e0',
    frame: false,
    show: true,
    title: 'JARVIS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('Falha ao carregar frontend:', errorCode, errorDescription);
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.show();
  mainWindow.focus();
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
  ipcMain.handle('project:list-files', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/project/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar arquivos.');
    return data;
  });
  ipcMain.handle('project:read-file', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/project/file`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao ler o arquivo.');
    return data;
  });
  ipcMain.handle('project:tree', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/project/tree`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar a pasta.');
    return data;
  });
  ipcMain.handle('project:preview', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/project/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao abrir o arquivo.');
    return data;
  });

  ipcMain.handle('memory:forget-session', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/memory/conversation/forget`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao apagar a memória da conversa.');
    return data;
  });

  ipcMain.handle('attachments:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Anexar arquivos ao chat',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => {
      try {
        return readAttachment(filePath);
      } catch (error) {
        return { name: path.basename(filePath), path: filePath, kind: 'error', error: error.message };
      }
    });
  });

  ipcMain.handle('backend:health', async () => {
    const response = await fetch(`${backend.url}/health`);
    return response.json();
  });
  ipcMain.handle('rag:health', async () => {
    const response = await fetch(`${backend.url}/api/rag/health`);
    return response.json();
  });
  ipcMain.handle('rag:index-project', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/rag/index`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao indexar o projeto.');
    return data;
  });
  ipcMain.handle('rag:search', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/rag/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao pesquisar no RAG.');
    return data;
  });
  ipcMain.handle('rag:documents', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/rag/documents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar o corpus.');
    return data;
  });
  ipcMain.handle('rag:save-note', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/rag/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao salvar a nota.');
    return data;
  });
  ipcMain.handle('memory:list', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/memory/list`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar memórias.');
    return data;
  });
  ipcMain.handle('memory:save', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/memory`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao salvar a memória.');
    return data;
  });
  ipcMain.handle('skills:list', async () => {
    const response = await fetch(`${backend.url}/api/skills`);
    return response.json();
  });
  ipcMain.handle('tools:list', async () => {
    const response = await fetch(`${backend.url}/api/tools`);
    return response.json();
  });
  ipcMain.handle('tools:approve', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/tools/approval`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao resolver a aprovação.');
    return data;
  });
  ipcMain.handle('quota:get', async () => {
    const response = await fetch(`${backend.url}/api/ollama/quota`);
    return response.json();
  });
  ipcMain.handle('quota:sync', async (_event, payload) => {
    const response = await fetch(`${backend.url}/api/ollama/quota/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    return response.json();
  });
  ipcMain.handle('quota:config', async (_event, payload) => {
    const data = await submitQuotaCookie(payload?.cookie || '');
    persistQuotaCookie(payload?.cookie || '');
    return data;
  });
  ipcMain.handle('quota:login', async () => openQuotaLoginWindow());
  ipcMain.handle('quota:logout', async () => {
    persistQuotaCookie('');
    return submitQuotaCookie('');
  });
  ipcMain.handle('quota:open-settings', async () => {
    await shell.openExternal('https://ollama.com/settings');
    return true;
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
        event.sender.send('backend:chat-event', streamEvent);
      }
    };

    try {
      const response = await fetch(`${backend.url}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(payload || {}), runId: requestId }),
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
      if (error?.name === 'AbortError') emit(createRunEvent(requestId, EVENT_TYPES.RUN_CANCELLED));
      else emit(createRunEvent(requestId, EVENT_TYPES.RUN_FAILED, {
        error: error?.message || 'Falha inesperada no streaming.',
      }));
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
  try {
    loadEnvironment();
    const { startBackend } = require('../backend/server');
    backend = await startBackend();
    console.log(`Backend rodando em ${backend.url}`);
    registerIpc();

    const savedCookie = loadPersistedQuotaCookie();
    if (savedCookie) {
      try {
        await submitQuotaCookie(savedCookie);
      } catch (error) {
        console.error('Falha ao restaurar sessão salva da quota:', error);
      }
    }

    createWindow();
  } catch (error) {
    console.error('Erro na inicialização do aplicativo:', error);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  closeLoginWindow();
  for (const controller of activeChatRequests.values()) controller.abort();
  activeChatRequests.clear();
  backend?.server?.close();
  if (process.platform !== 'darwin') app.quit();
});
