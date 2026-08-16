const { app, BrowserWindow, dialog, ipcMain, shell, session, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { EVENT_TYPES, createRunEvent } = require('../backend/protocol');
const { defaultPtyManager } = require('../backend/pty-manager');

const OLLAMA_ORIGIN = 'https://ollama.com';
let backend = null;
let mobileGateway = null;

// Toda conversa com o backend passa por aqui para carregar o token de
// autenticacao. O token vive apenas no processo principal: o preload nao o
// expoe e o renderer nunca o ve.
function backendFetch(caminho, opcoes = {}) {
  if (!backend?.authToken) throw new Error('O backend ainda nao esta pronto.');
  return fetch(`${backend.url}${caminho}`, {
    ...opcoes,
    headers: { ...(opcoes.headers || {}), Authorization: `Bearer ${backend.authToken}` },
  });
}
let loginWindow = null;

app.disableHardwareAcceleration();
// A pasta de cache em disco do Chromium tem dado "Acesso negado" nesta máquina
// (ver logs), o que faz o renderer servir index.html/styles.css antigos em vez
// de reler o arquivo. Desabilitar o cache HTTP evita esse tipo de tela presa.
app.commandLine.appendSwitch('disable-http-cache');

let mainWindow;
const activeChatRequests = new Map();
const activeSearchRequests = new Map();

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
  const response = await backendFetch('/api/ollama/quota/config', {
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

  const winId = mainWindow.id;
  mainWindow.on('closed', () => {
    defaultPtyManager.disposeWindowSessions(winId);
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
    const response = await backendFetch('/api/project/files', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar arquivos.');
    return data;
  });
  ipcMain.handle('project:read-file', async (_event, payload) => {
    const response = await backendFetch('/api/project/file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao ler o arquivo.');
    return data;
  });
  ipcMain.handle('project:tree', async (_event, payload) => {
    const response = await backendFetch('/api/project/tree', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar a pasta.');
    return data;
  });
  ipcMain.handle('project:preview', async (_event, payload) => {
    const response = await backendFetch('/api/project/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao abrir o arquivo.');
    return data;
  });

  // Salvar nao lanca erro no conflito: um arquivo mudado no disco e' um
  // resultado previsto que a interface precisa tratar com escolha do usuario,
  // e o IPC perde propriedades customizadas de um Error.
  ipcMain.handle('project:save', async (_event, payload) => {
    const response = await backendFetch('/api/project/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (response.ok) return { ok: true, ...data };
    return { ok: false, code: data.code || null, error: data.error || 'Falha ao salvar o arquivo.', hashAtual: data.hashAtual ?? null };
  });
  ipcMain.handle('project:stat', async (_event, payload) => {
    const response = await backendFetch('/api/project/stat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao consultar o arquivo.');
    return data;
  });

  // "Salvar como" so' escolhe o destino; a gravacao continua passando pelo
  // backend. Devolvemos o caminho RELATIVO ao projeto -- se o usuario escolher
  // uma pasta fora, recusamos aqui e o backend recusaria de novo por conta propria.
  ipcMain.handle('project:choose-save-path', async (_event, payload) => {
    const projectPath = path.resolve(String(payload?.projectPath || ''));
    if (!payload?.projectPath) throw new Error('Nenhum projeto aberto.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Salvar como',
      defaultPath: path.join(projectPath, String(payload.path || '')),
    });
    if (result.canceled || !result.filePath) return null;
    const relative = path.relative(projectPath, result.filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Escolha um destino dentro do projeto aberto.');
    }
    return { path: relative.split(path.sep).join('/') };
  });

  // Git pela ponte: cada acao e' um clique do usuario na aba Diff.
  const rotaGit = (canal, rota, erroPadrao) => {
    ipcMain.handle(canal, async (_event, payload) => {
      const response = await backendFetch(rota, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || erroPadrao);
      return data;
    });
  };
  rotaGit('git:status', '/api/git/status', 'Falha ao ler o repositório.');
  rotaGit('git:diff', '/api/git/diff', 'Falha ao ler o diff.');
  rotaGit('git:stage', '/api/git/stage', 'Falha ao preparar os arquivos.');
  rotaGit('git:unstage', '/api/git/unstage', 'Falha ao tirar os arquivos do commit.');
  rotaGit('git:commit-scope', '/api/git/commit-scope', 'Falha ao ler o escopo do commit.');
  rotaGit('git:commit', '/api/git/commit', 'Falha ao criar o commit.');

  ipcMain.handle('memory:forget-session', async (_event, payload) => {
    const response = await backendFetch('/api/memory/conversation/forget', {
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

  ipcMain.handle('models:list', async () => {
    const response = await backendFetch('/api/models');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar modelos.');
    return data;
  });

  ipcMain.handle('backend:health', async () => {
    const response = await backendFetch('/health');
    return response.json();
  });
  ipcMain.handle('rag:health', async () => {
    const response = await backendFetch('/api/rag/health');
    return response.json();
  });
  ipcMain.handle('rag:index-project', async (_event, payload) => {
    const response = await backendFetch('/api/rag/index', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao indexar o projeto.');
    return data;
  });
  ipcMain.handle('rag:index-status', async (_event, id) => {
    const response = await backendFetch(`/api/rag/index/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao consultar a indexação.');
    return data;
  });
  ipcMain.handle('rag:index-cancel', async (_event, id) => {
    const response = await backendFetch(`/api/rag/index/${encodeURIComponent(id)}`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao cancelar a indexação.');
    return data;
  });
  ipcMain.handle('rag:config', async (_event, payload) => {
    const response = await backendFetch('/api/rag/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao configurar o RAG.');
    return data;
  });
  ipcMain.handle('rag:services', async (_event, payload) => {
    const response = await backendFetch('/api/rag/services', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao controlar os serviços do RAG.');
    return data;
  });
  ipcMain.handle('rag:search', async (_event, payload) => {
    const response = await backendFetch('/api/rag/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao pesquisar no RAG.');
    return data;
  });
  ipcMain.handle('rag:documents', async (_event, payload) => {
    const response = await backendFetch('/api/rag/documents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar o corpus.');
    return data;
  });
  ipcMain.handle('rag:save-note', async (_event, payload) => {
    const response = await backendFetch('/api/rag/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao salvar a nota.');
    return data;
  });
  ipcMain.handle('memory:list', async (_event, payload) => {
    const response = await backendFetch('/api/memory/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar memórias.');
    return data;
  });
  ipcMain.handle('memory:save', async (_event, payload) => {
    const response = await backendFetch('/api/memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao salvar a memória.');
    return data;
  });
  const memoryPost = (channel, route, fallback) => {
    ipcMain.handle(channel, async (_event, payload) => {
      const response = await backendFetch(route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || fallback);
      return data;
    });
  };
  memoryPost('memory:update', '/api/memory/update', 'Falha ao atualizar a memória.');
  memoryPost('memory:delete', '/api/memory/delete', 'Falha ao apagar a memória.');
  memoryPost('memory:conversation-list', '/api/memory/conversation/list', 'Falha ao listar a memória entre conversas.');
  memoryPost('memory:conversation-delete', '/api/memory/conversation/delete', 'Falha ao apagar o trecho de conversa.');
  memoryPost('memory:conversation-clear', '/api/memory/conversation/clear', 'Falha ao limpar a memória entre conversas.');
  memoryPost('memory:conversation-settings', '/api/memory/conversation/settings', 'Falha ao configurar a memória entre conversas.');
  ipcMain.handle('memory:export', async (_event, payload) => {
    const [explicitResponse, conversationResponse] = await Promise.all([
      backendFetch('/api/memory/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
      }),
      backendFetch('/api/memory/conversation/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
      }),
    ]);
    const explicit = await explicitResponse.json();
    const conversations = await conversationResponse.json();
    if (!explicitResponse.ok || !conversationResponse.ok) {
      throw new Error(explicit.error || conversations.error || 'Falha ao exportar memórias.');
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar memórias do JARVIS',
      defaultPath: `jarvis-memory-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    const document = { version: 1, exportedAt: new Date().toISOString(), explicit, conversations };
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    return { cancelled: false, filePath: result.filePath };
  });
  ipcMain.handle('skills:list', async () => {
    const response = await backendFetch('/api/skills');
    return response.json();
  });
  ipcMain.handle('skills:reviews', async () => {
    const response = await backendFetch('/api/skills/reviews');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar revisões de skills.');
    return data;
  });
  ipcMain.handle('skills:review', async (_event, payload) => {
    const response = await backendFetch('/api/skills/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao revisar skills.');
    return data;
  });
  ipcMain.handle('skills:resolve-review', async (_event, payload) => {
    const response = await backendFetch('/api/skills/reviews/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao resolver a revisão de skill.');
    return data;
  });
  ipcMain.handle('skills:curate', async (_event, payload) => {
    const response = await backendFetch('/api/skills/curate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao executar a curadoria de skills.');
    return data;
  });
  ipcMain.handle('skills:policy', async (_event, payload) => {
    const response = await backendFetch('/api/skills/policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao atualizar a política da skill.');
    return data;
  });
  ipcMain.handle('tools:list', async () => {
    const response = await backendFetch('/api/tools');
    return response.json();
  });
  ipcMain.handle('tools:approve', async (_event, payload) => {
    const response = await backendFetch('/api/tools/approval', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao resolver a aprovação.');
    return data;
  });
  ipcMain.handle('tools:terminal-job', async (_event, payload) => {
    const id = encodeURIComponent(String(payload?.id || ''));
    const response = await backendFetch(`/api/tools/terminal-jobs/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao consultar o comando em segundo plano.');
    return data;
  });
  ipcMain.handle('tools:cancel-terminal-job', async (_event, payload) => {
    const id = encodeURIComponent(String(payload?.id || ''));
    const response = await backendFetch(`/api/tools/terminal-jobs/${id}`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao cancelar o comando em segundo plano.');
    return data;
  });
  ipcMain.handle('tools:background-job', async (_event, payload) => {
    const id = encodeURIComponent(String(payload?.id || ''));
    const response = await backendFetch(`/api/tools/background-jobs/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao consultar o job em segundo plano.');
    return data;
  });
  ipcMain.handle('tools:cancel-background-job', async (_event, payload) => {
    const id = encodeURIComponent(String(payload?.id || ''));
    const response = await backendFetch(`/api/tools/background-jobs/${id}`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao cancelar o job em segundo plano.');
    return data;
  });
  ipcMain.handle('search:query', async (event, payload) => {
    const ownerId = String(event.sender.id);
    activeSearchRequests.get(ownerId)?.abort();
    const controller = new AbortController();
    activeSearchRequests.set(ownerId, controller);
    try {
      const response = await backendFetch('/api/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Falha na busca global.');
      return data;
    } finally {
      if (activeSearchRequests.get(ownerId) === controller) activeSearchRequests.delete(ownerId);
    }
  });
  ipcMain.handle('search:cancel', async (event) => {
    const ownerId = String(event.sender.id);
    const controller = activeSearchRequests.get(ownerId);
    if (!controller) return false;
    controller.abort();
    activeSearchRequests.delete(ownerId);
    return true;
  });
  ipcMain.handle('search:plan-replace', async (event, payload) => {
    const response = await backendFetch('/api/search/plan-replace', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(payload || {}), ownerId: String(event.sender.id) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao planejar substituição.');
    return data;
  });
  ipcMain.handle('search:apply-replace', async (event, payload) => {
    const response = await backendFetch('/api/search/apply-replace', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: payload?.planId, ownerId: String(event.sender.id) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao aplicar substituição.');
    return data;
  });
  ipcMain.handle('problems:run', async (_event, payload) => {
    const response = await backendFetch('/api/problems/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao executar diagnósticos.');
    return data;
  });
  ipcMain.handle('problems:cancel', async (_event, payload) => {
    const response = await backendFetch('/api/problems/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao cancelar diagnóstico.');
    return data;
  });
  ipcMain.handle('agent:jobs', async () => {
    const response = await backendFetch('/api/agent/jobs');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao listar jobs.');
    return data;
  });
  ipcMain.handle('agent:cancel-job', async (_event, payload) => {
    const response = await backendFetch('/api/agent/jobs/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao cancelar job.');
    return data;
  });
  ipcMain.handle('agent:checkpoint', async (_event, payload) => {
    const response = await backendFetch('/api/agent/checkpoints', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao buscar checkpoint.');
    return data;
  });
  ipcMain.handle('quota:get', async () => {
    const response = await backendFetch('/api/ollama/quota');
    return response.json();
  });
  ipcMain.handle('quota:sync', async (_event, payload) => {
    const response = await backendFetch('/api/ollama/quota/sync', {
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
    const response = await backendFetch('/api/chat', {
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
      const response = await backendFetch('/api/chat/stream', {
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

  // PTY interativo do usuario (estritamente isolado do agente)
  const ptyWindowId = (event) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
    if (windowId === null || windowId === undefined) throw new Error('Janela solicitante inválida para operação PTY.');
    return windowId;
  };

  ipcMain.handle('pty:create', async (event, payload) => {
    const windowId = ptyWindowId(event);
    const session = defaultPtyManager.createSession({
      cwd: payload?.cwd,
      cols: payload?.cols,
      rows: payload?.rows,
      windowId,
      onData: (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('pty:data', { sessionId: session.sessionId, data });
        }
      },
      onExit: ({ exitCode, signal }) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('pty:exit', { sessionId: session.sessionId, exitCode, signal });
        }
      },
    });
    return session;
  });

  ipcMain.handle('pty:write', async (event, payload) => {
    return defaultPtyManager.write(payload?.sessionId, payload?.data, ptyWindowId(event));
  });

  ipcMain.handle('pty:resize', async (event, payload) => {
    return defaultPtyManager.resize(payload?.sessionId, payload?.cols, payload?.rows, ptyWindowId(event));
  });

  ipcMain.handle('pty:kill', async (event, payload) => {
    return defaultPtyManager.killSession(payload?.sessionId, ptyWindowId(event));
  });

  ipcMain.handle('pty:restart', async (event, payload) => {
    const windowId = ptyWindowId(event);
    const session = await defaultPtyManager.restartSession(payload?.sessionId, {
      cwd: payload?.cwd,
      cols: payload?.cols,
      rows: payload?.rows,
      windowId,
      onData: (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('pty:data', { sessionId: session.sessionId, data });
        }
      },
      onExit: ({ exitCode, signal }) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('pty:exit', { sessionId: session.sessionId, exitCode, signal });
        }
      },
    });
    return session;
  });
}

app.whenReady().then(async () => {
  try {
    loadEnvironment();
    if (!process.env.JARVIS_SKILL_REVIEW_PATH) {
      process.env.JARVIS_SKILL_REVIEW_PATH = path.join(app.getPath('userData'), 'skill-reviews');
    }
    const { startBackend } = require('../backend/server');
    backend = await startBackend();
    console.log(`Backend rodando em ${backend.url}`);
    if (process.env.JARVIS_MOBILE_ENABLED === '1') {
      const { startMobileGateway } = require('../backend/mobile-gateway');
      mobileGateway = await startMobileGateway({ backendUrl: backend.url, backendToken: backend.authToken });
      console.log(`Gateway móvel rodando em ${mobileGateway.url}`);
    }
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
  defaultPtyManager.disposeAll();
  for (const controller of activeChatRequests.values()) controller.abort();
  activeChatRequests.clear();
  backend?.server?.close();
  mobileGateway?.server?.close();
  if (process.platform !== 'darwin') app.quit();
});
