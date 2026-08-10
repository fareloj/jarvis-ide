const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const bridge = window.jarvis;

const state = {
  nav: 'chat',
  view: 'chat',
  sidebarOpen: true,
  inspectorOpen: true,
  busy: false,
  model: localStorage.getItem('jarvis:model') || 'gpt-oss:120b-cloud',
  messages: JSON.parse(localStorage.getItem('jarvis:messages') || '[]'),
  project: JSON.parse(localStorage.getItem('jarvis:project') || 'null') || {
    name: 'orion-api',
    path: '~/dev/orion-api',
  },
};

const elements = {
  welcome: $('#welcomeScreen'),
  workspace: $('#workspace'),
  sidebar: $('#sidebar'),
  sidebarHandle: $('#sidebarHandle'),
  sidebarTitle: $('#sidebarTitle'),
  sidebarBody: $('#sidebarBody'),
  sidebarFooter: $('#sidebarFooter'),
  inspector: $('#inspector'),
  workbench: $('.workbench'),
  editorTabs: $('.editor-tabs'),
  bottomPanel: $('#bottomPanel'),
  chatForm: $('#chatForm'),
  chatInput: $('#chatInput'),
  chatFeed: $('#chatFeed'),
  chatScroll: $('#chatScroll'),
  sendButton: $('#sendButton'),
  connection: $('#connectionStatus'),
  welcomeBackend: $('#welcomeBackend'),
  messageCount: $('#messageCount'),
  modelLabel: $('#activeModelLabel'),
  inspectorModel: $('#inspectorModel'),
  projectName: $('#projectName'),
  toastRegion: $('#toastRegion'),
};

const sidebarTemplates = {
  chat: () => `
    <div class="sidebar-search"><i class="ph-duotone ph-magnifying-glass"></i><span>Buscar conversas…</span></div>
    <div class="sidebar-section">
      <button class="sidebar-link active" data-action="new-chat"><i class="ph-duotone ph-chat-circle-dots"></i>Conversa atual</button>
      <button class="sidebar-link" data-nav="history"><i class="ph-duotone ph-clock-counter-clockwise"></i>Histórico local</button>
    </div>
    <div class="sidebar-section">
      <p class="eyebrow" style="margin:4px 8px 8px">Sessão</p>
      <button class="sidebar-link"><i class="ph-duotone ph-brain"></i>${shortModel(state.model)}</button>
      <button class="sidebar-link"><i class="ph-duotone ph-shield-check"></i>Somente conversa</button>
    </div>`,
  files: () => `
    <div class="sidebar-search"><i class="ph-duotone ph-magnifying-glass"></i><span>Buscar arquivos…</span></div>
    <div class="file-tree">
      <div class="tree-item folder"><i class="ph-duotone ph-caret-down"></i><i class="ph-duotone ph-folder-open"></i><span>${escapeHtml(state.project.name)}</span></div>
      <div class="tree-item folder indent-1"><i class="ph-duotone ph-caret-down"></i><i class="ph-duotone ph-folder-open"></i><span>src</span></div>
      <div class="tree-item active indent-2" data-view="editor"><i class="ph-duotone ph-file-ts"></i><span>app.ts</span><span class="file-state">M</span></div>
      <div class="tree-item indent-2"><i class="ph-duotone ph-file-ts"></i><span>client.ts</span></div>
      <div class="tree-item indent-2"><i class="ph-duotone ph-file-css"></i><span>styles.css</span></div>
      <div class="tree-item folder indent-1"><i class="ph-duotone ph-caret-right"></i><i class="ph-duotone ph-folder"></i><span>electron</span></div>
      <div class="tree-item folder indent-1"><i class="ph-duotone ph-caret-right"></i><i class="ph-duotone ph-folder"></i><span>backend</span></div>
      <div class="tree-item indent-1"><i class="ph-duotone ph-file-json"></i><span>package.json</span></div>
      <div class="tree-item indent-1"><i class="ph-duotone ph-file-text"></i><span>README.md</span></div>
    </div>`,
  diff: () => `
    <div class="sidebar-section">
      <p class="eyebrow" style="margin:4px 8px 8px">Alterações</p>
      <button class="sidebar-link active"><i class="ph-duotone ph-file-ts"></i>src/app.ts <span class="file-state" style="margin-left:auto">M</span></button>
      <button class="sidebar-link"><i class="ph-duotone ph-file-css"></i>src/styles.css <span class="file-state" style="margin-left:auto">M</span></button>
      <button class="sidebar-link"><i class="ph-duotone ph-file-js"></i>backend/server.js <span class="file-state" style="margin-left:auto">A</span></button>
    </div>`,
  rag: () => `
    <div class="sidebar-section">
      <button class="sidebar-link active"><i class="ph-duotone ph-database"></i>código-fonte</button>
      <button class="sidebar-link"><i class="ph-duotone ph-book-open-text"></i>documentação</button>
      <button class="sidebar-link"><i class="ph-duotone ph-git-pull-request"></i>histórico de PRs</button>
    </div>`,
  history: () => `
    <div class="sidebar-section">
      <button class="sidebar-link active"><i class="ph-duotone ph-calendar-blank"></i>Hoje</button>
      <button class="sidebar-link"><i class="ph-duotone ph-calendar-dots"></i>Esta semana</button>
      <button class="sidebar-link"><i class="ph-duotone ph-archive"></i>Arquivadas</button>
    </div>`,
  settings: () => `
    <div class="sidebar-section">
      <button class="sidebar-link active"><i class="ph-duotone ph-sliders-horizontal"></i>Geral</button>
      <button class="sidebar-link"><i class="ph-duotone ph-brain"></i>Modelo</button>
      <button class="sidebar-link"><i class="ph-duotone ph-palette"></i>Aparência</button>
      <button class="sidebar-link"><i class="ph-duotone ph-shield"></i>Privacidade</button>
    </div>`,
};

const navMeta = {
  chat: ['Conversas', 'chat'],
  files: ['Explorador', 'editor'],
  diff: ['Alterações', 'diff'],
  rag: ['RAG', null],
  history: ['Histórico', null],
  settings: ['Configurações', null],
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortModel(model) {
  if (model.startsWith('gpt-oss')) return 'GPT-OSS 120B';
  if (model.startsWith('qwen3-coder')) return 'Qwen3 Coder 480B';
  return model;
}

function timeLabel(date = new Date()) {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function renderMarkdown(container, content) {
  if (!window.marked || !window.DOMPurify) {
    const paragraph = document.createElement('p');
    paragraph.textContent = content;
    container.replaceChildren(paragraph);
    return;
  }

  const parsed = window.marked.parse(String(content), {
    async: false,
    breaks: true,
    gfm: true,
  });
  const sanitized = window.DOMPurify.sanitize(parsed, {
    USE_PROFILES: { html: true },
  });
  container.innerHTML = sanitized;

  $$('a', container).forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });

  $$('pre > code', container).forEach((code) => {
    const pre = code.parentElement;
    const languageClass = [...code.classList].find((name) => name.startsWith('language-'));
    const language = languageClass?.slice('language-'.length) || 'texto';
    const block = document.createElement('div');
    block.className = 'code-block';
    block.innerHTML = `
      <div class="code-toolbar">
        <span class="code-language"></span>
        <button class="copy-code" type="button"><i class="ph-duotone ph-copy"></i><span>Copiar</span></button>
      </div>`;
    $('.code-language', block).textContent = language;
    pre.before(block);
    block.append(pre);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
}

function persist() {
  localStorage.setItem('jarvis:messages', JSON.stringify(state.messages.slice(-40)));
  localStorage.setItem('jarvis:model', state.model);
  localStorage.setItem('jarvis:project', JSON.stringify(state.project));
}

function log(message) {
  const output = $('#logOutput');
  if (!output) return;
  const line = document.createElement('div');
  line.textContent = `${timeLabel()}  ${message}`;
  output.append(line);
}

function toast(title, message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<i class="ph-duotone ${type === 'error' ? 'ph-warning-circle' : 'ph-info'}"></i><div><strong></strong><span></span></div>`;
  $('strong', item).textContent = title;
  $('span', item).textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 4200);
}

function enterWorkspace() {
  elements.welcome.classList.add('hidden');
  elements.workspace.classList.remove('hidden');
  switchNav('chat');
  setTimeout(() => elements.chatInput.focus(), 60);
}

function showWelcome() {
  elements.workspace.classList.add('hidden');
  elements.welcome.classList.remove('hidden');
}

function renderSidebar() {
  elements.sidebarTitle.textContent = navMeta[state.nav][0];
  elements.sidebarBody.innerHTML = sidebarTemplates[state.nav]();
  elements.sidebarFooter.innerHTML = state.nav === 'files'
    ? '<span>12 arquivos</span><span class="accent-text">1 alterado</span>'
    : state.nav === 'chat'
      ? `<span>${state.messages.length} mensagens</span><span class="accent-text">local</span>`
      : '<span>JARVIS MVP</span><span class="accent-text">prévia</span>';
}

function specialPage(type) {
  const page = document.createElement('section');
  page.className = type === 'settings' ? 'content-view settings-page special-page' : 'content-view placeholder-page special-page';

  if (type === 'settings') {
    page.innerHTML = `
      <h1>Configurações</h1>
      <p class="page-intro">Preferências locais do frontend e conexão do chatbot. As credenciais continuam fora da interface.</p>
      <div class="settings-grid">
        <section class="settings-group">
          <h2>Modelo</h2>
          <div class="setting-row"><span><strong>Modelo principal</strong><small>Enviado em cada conversa</small></span><select id="modelSelect"><option value="gpt-oss:120b-cloud">GPT-OSS 120B Cloud</option><option value="qwen3-coder:480b-cloud">Qwen3 Coder 480B Cloud</option></select></div>
          <div class="setting-row"><span><strong>Ollama</strong><small>Configurado pelo arquivo .env</small></span><button class="button compact secondary" id="testConnection">Testar</button></div>
        </section>
        <section class="settings-group">
          <h2>Aparência</h2>
          <div class="setting-row"><span><strong>Fonte da interface</strong><small>Inter</small></span><span>Inter</span></div>
          <div class="setting-row"><span><strong>Fonte editorial</strong><small>Marca e títulos</small></span><span>Source Serif 4</span></div>
          <div class="setting-row"><span><strong>Painel de contexto</strong><small>Exibir à direita</small></span><button class="toggle ${state.inspectorOpen ? 'on' : ''}" data-action="toggle-inspector" aria-label="Alternar painel"></button></div>
        </section>
        <section class="settings-group">
          <h2>Privacidade</h2>
          <div class="setting-row"><span><strong>Histórico local</strong><small>Salvo apenas neste dispositivo</small></span><button class="toggle on"></button></div>
          <div class="setting-row"><span><strong>Limpar conversa</strong><small>Remove o histórico deste projeto</small></span><button class="button compact secondary" data-action="new-chat">Limpar</button></div>
        </section>
        <section class="settings-group">
          <h2>Recursos futuros</h2>
          <div class="setting-row"><span><strong>RAG</strong><small>Desativado no MVP</small></span><button class="toggle" disabled></button></div>
          <div class="setting-row"><span><strong>Skills e terminal</strong><small>Desativados no MVP</small></span><button class="toggle" disabled></button></div>
        </section>
      </div>`;
  } else if (type === 'rag') {
    page.innerHTML = `
      <h1>Conhecimento do projeto</h1>
      <p class="page-intro">A interface do RAG está reservada, mas nenhuma indexação ou recuperação é executada neste MVP.</p>
      <div class="placeholder-card"><i class="ph-duotone ph-database"></i><h2>RAG entra na próxima fase</h2><p>Quando ativado, este espaço mostrará corpora, progresso de indexação, saúde do índice e resultados de busca híbrida.</p></div>`;
  } else {
    const count = state.messages.length;
    page.innerHTML = `
      <h1>Histórico local</h1>
      <p class="page-intro">Conversas armazenadas somente no perfil local do Electron.</p>
      <div class="placeholder-card magenta"><i class="ph-duotone ph-clock-counter-clockwise"></i><h2>${count ? `${count} mensagens nesta sessão` : 'Nenhuma conversa salva'}</h2><p>${count ? 'Volte ao chat para continuar de onde parou ou inicie uma nova conversa.' : 'Sua primeira conversa aparecerá aqui automaticamente.'}</p></div>`;
  }
  return page;
}

function switchNav(nav) {
  if (!navMeta[nav]) return;
  state.nav = nav;
  const [, view] = navMeta[nav];

  $$('.rail-button').forEach((button) => button.classList.toggle('active', button.dataset.nav === nav));
  renderSidebar();
  $('.special-page')?.remove();

  if (view) {
    elements.editorTabs.classList.remove('hidden');
    elements.bottomPanel.classList.remove('hidden');
    switchView(view);
  } else {
    elements.editorTabs.classList.add('hidden');
    elements.bottomPanel.classList.add('hidden');
    $$('[data-content-view]').forEach((section) => section.classList.add('hidden'));
    elements.workbench.insertBefore(specialPage(nav), elements.bottomPanel);
    if (nav === 'settings') {
      const select = $('#modelSelect');
      select.value = state.model;
      select.addEventListener('change', () => setModel(select.value));
      $('#testConnection').addEventListener('click', checkHealth);
    }
  }
}

function switchView(view) {
  state.view = view;
  $$('.editor-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  $$('[data-content-view]').forEach((section) => section.classList.toggle('hidden', section.dataset.contentView !== view));
}

function setModel(model) {
  state.model = model;
  persist();
  elements.modelLabel.textContent = shortModel(model);
  elements.inspectorModel.textContent = shortModel(model).replace(' 120B', '').replace(' 480B', '');
  renderSidebar();
  toast('Modelo atualizado', `${shortModel(model)} será usado nas próximas mensagens.`);
}

function appendMessage(role, content, options = {}) {
  const article = document.createElement('article');
  article.className = `message ${role === 'user' ? 'user-message' : 'assistant-message'}${options.error ? ' error-message' : ''}`;
  const avatar = role === 'user'
    ? '<div class="avatar user-avatar">VOCÊ</div>'
    : `<div class="avatar assistant-avatar"><i class="ph-duotone ${options.error ? 'ph-warning' : 'ph-sparkle'}"></i></div>`;
  article.innerHTML = `${avatar}<div class="message-content"><div class="message-meta"><strong>${role === 'user' ? 'Você' : 'JARVIS'}</strong><span>${options.time || timeLabel()}</span></div><div class="markdown-body"></div></div>`;
  const body = $('.markdown-body', article);
  if (role === 'assistant' && !options.error) {
    renderMarkdown(body, content);
  } else {
    const paragraph = document.createElement('p');
    paragraph.textContent = content;
    body.append(paragraph);
  }
  elements.chatFeed.append(article);
  elements.messageCount.textContent = String(1 + state.messages.length);
  requestAnimationFrame(() => { elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight; });
  return article;
}

function appendTyping() {
  const article = document.createElement('article');
  article.className = 'message assistant-message typing-message';
  article.innerHTML = '<div class="avatar assistant-avatar"><i class="ph-duotone ph-sparkle"></i></div><div class="message-content"><div class="message-meta"><strong>JARVIS</strong><span>pensando</span></div><div class="typing-dots"><span></span><span></span><span></span></div></div>';
  elements.chatFeed.append(article);
  elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
  return article;
}

function renderSavedMessages() {
  for (const message of state.messages) appendMessage(message.role, message.content, { time: message.time });
}

async function sendMessage(text) {
  const content = text.trim();
  if (!content || state.busy) return;
  state.busy = true;
  elements.sendButton.disabled = true;
  elements.chatInput.value = '';
  resizeComposer();

  const userMessage = { role: 'user', content, time: timeLabel() };
  state.messages.push(userMessage);
  appendMessage('user', content, { time: userMessage.time });
  persist();
  renderSidebar();
  const typing = appendTyping();
  log(`chat · mensagem enviada para ${state.model}`);

  try {
    if (!bridge?.backend) throw new Error('Abra a interface pelo Electron para usar o backend.');
    const response = await bridge.backend.chat({
      model: state.model,
      messages: [
        {
          role: 'system',
          content: 'Você é JARVIS, um assistente de desenvolvimento útil e direto. Neste MVP você é apenas um chatbot: não afirme ter acessado arquivos, terminal, RAG, ferramentas ou skills. Responda em português quando o usuário falar em português.',
        },
        ...state.messages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
      ],
    });
    typing.remove();
    const assistantMessage = { role: 'assistant', content: response.message || 'O modelo não retornou conteúdo.', time: timeLabel() };
    state.messages.push(assistantMessage);
    appendMessage('assistant', assistantMessage.content, { time: assistantMessage.time });
    log(`chat · resposta recebida de ${response.model || state.model}`);
  } catch (error) {
    typing.remove();
    appendMessage('assistant', `Não consegui conversar com o modelo: ${error.message}`, { error: true });
    log(`erro · ${error.message}`);
    toast('Falha no chatbot', error.message, 'error');
  } finally {
    state.busy = false;
    elements.sendButton.disabled = false;
    persist();
    renderSidebar();
    elements.chatInput.focus();
  }
}

function newChat() {
  state.messages = [];
  persist();
  $$('.message', elements.chatFeed).forEach((message) => {
    if (!message.classList.contains('welcome-message')) message.remove();
  });
  elements.messageCount.textContent = '1';
  renderSidebar();
  enterWorkspace();
  toast('Nova conversa', 'O histórico da sessão anterior foi removido.');
}

function resizeComposer() {
  elements.chatInput.style.height = 'auto';
  elements.chatInput.style.height = `${Math.min(elements.chatInput.scrollHeight, 130)}px`;
}

async function checkHealth() {
  const dot = $('.status-dot', elements.connection);
  const label = $('.connection-label', elements.connection);
  dot.className = 'status-dot checking';
  label.textContent = 'conectando…';
  elements.welcomeBackend.textContent = 'verificando';

  try {
    if (!bridge?.backend) throw new Error('Electron indisponível');
    const health = await bridge.backend.health();
    const ollama = health.ollama;
    dot.className = `status-dot ${ollama.online ? 'online' : 'offline'}`;
    label.textContent = ollama.online ? `${ollama.provider} · ${ollama.latencyMs} ms` : 'Ollama offline';
    elements.welcomeBackend.textContent = ollama.online ? 'online' : 'offline';
    if (!ollama.online) toast('Ollama offline', 'Inicie o Ollama e faça login para usar o modelo Cloud.', 'error');
  } catch {
    dot.className = 'status-dot offline';
    label.textContent = 'backend offline';
    elements.welcomeBackend.textContent = 'offline';
  }
}

async function openProject() {
  if (!bridge?.project) {
    toast('Electron necessário', 'O seletor nativo de pastas funciona dentro do aplicativo.', 'error');
    return;
  }
  const project = await bridge.project.open();
  if (!project) return;
  state.project = project;
  elements.projectName.textContent = project.name;
  persist();
  enterWorkspace();
  renderSidebar();
  toast('Projeto aberto', `${project.name} foi selecionado. O acesso aos arquivos ainda está desativado.`);
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  elements.sidebar.classList.toggle('hidden', !state.sidebarOpen);
  elements.sidebarHandle.classList.toggle('hidden', state.sidebarOpen);
}

function toggleInspector() {
  state.inspectorOpen = !state.inspectorOpen;
  elements.inspector.classList.toggle('hidden', !state.inspectorOpen);
  const toggle = $('.toggle[data-action="toggle-inspector"]');
  toggle?.classList.toggle('on', state.inspectorOpen);
}

function initBottomResize() {
  const resizer = $('.bottom-resizer');
  resizer.addEventListener('pointerdown', (event) => {
    const startY = event.clientY;
    const startHeight = elements.bottomPanel.getBoundingClientRect().height;
    const move = (moveEvent) => {
      const next = Math.max(100, Math.min(360, startHeight + startY - moveEvent.clientY));
      elements.bottomPanel.style.height = `${next}px`;
      elements.bottomPanel.style.flexBasis = `${next}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, [data-view], [data-nav], [data-action]');
  if (!target) return;

  if (target.classList.contains('copy-code')) {
    const code = target.closest('.code-block')?.querySelector('code')?.textContent || '';
    await copyText(code);
    const label = $('span', target);
    label.textContent = 'Copiado';
    target.classList.add('copied');
    setTimeout(() => {
      label.textContent = 'Copiar';
      target.classList.remove('copied');
    }, 1600);
    return;
  }

  if (target.dataset.windowAction && bridge?.window) {
    if (target.dataset.windowAction === 'close') await bridge.window.close();
    if (target.dataset.windowAction === 'minimize') await bridge.window.minimize();
    if (target.dataset.windowAction === 'maximize') await bridge.window.toggleMaximize();
    return;
  }

  if (target.dataset.nav) {
    elements.welcome.classList.add('hidden');
    elements.workspace.classList.remove('hidden');
    switchNav(target.dataset.nav);
    return;
  }
  if (target.dataset.view) switchView(target.dataset.view);

  const action = target.dataset.action;
  if (action === 'home') showWelcome();
  if (action === 'enter-workspace') enterWorkspace();
  if (action === 'open-project') openProject();
  if (action === 'new-chat') newChat();
  if (action === 'toggle-sidebar') toggleSidebar();
  if (action === 'toggle-inspector') toggleInspector();
  if (action === 'toggle-bottom') elements.bottomPanel.classList.toggle('collapsed');
});

elements.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(elements.chatInput.value);
});

elements.chatInput.addEventListener('input', resizeComposer);
elements.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
});

$$('.bottom-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.bottom-tab').forEach((item) => item.classList.toggle('active', item === tab));
    $$('[data-bottom-view]').forEach((view) => view.classList.toggle('hidden', view.dataset.bottomView !== tab.dataset.bottom));
  });
});

$('#modelPicker').addEventListener('click', () => {
  elements.welcome.classList.add('hidden');
  elements.workspace.classList.remove('hidden');
  switchNav('settings');
});

document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey) return;
  if (event.key.toLowerCase() === 'o') { event.preventDefault(); openProject(); }
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); newChat(); }
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); toast('Paleta de comandos', 'Esse recurso será conectado em uma próxima etapa.'); }
});

elements.projectName.textContent = state.project.name;
setModel(state.model);
renderSavedMessages();
renderSidebar();
initBottomResize();
checkHealth();
