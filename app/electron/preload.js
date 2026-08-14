const { contextBridge, ipcRenderer } = require('electron');

function createRequestId() {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${Date.now()}-${suffix}`;
}

contextBridge.exposeInMainWorld('jarvis', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    listFiles: (payload) => ipcRenderer.invoke('project:list-files', payload),
    readFile: (payload) => ipcRenderer.invoke('project:read-file', payload),
    tree: (payload) => ipcRenderer.invoke('project:tree', payload),
    preview: (payload) => ipcRenderer.invoke('project:preview', payload),
    save: (payload) => ipcRenderer.invoke('project:save', payload),
    stat: (payload) => ipcRenderer.invoke('project:stat', payload),
    chooseSavePath: (payload) => ipcRenderer.invoke('project:choose-save-path', payload),
  },
  attachments: {
    pick: () => ipcRenderer.invoke('attachments:pick'),
  },
  rag: {
    health: () => ipcRenderer.invoke('rag:health'),
    indexProject: (payload) => ipcRenderer.invoke('rag:index-project', payload),
    search: (payload) => ipcRenderer.invoke('rag:search', payload),
    documents: (payload) => ipcRenderer.invoke('rag:documents', payload),
    saveNote: (payload) => ipcRenderer.invoke('rag:save-note', payload),
  },
  memory: {
    list: (payload) => ipcRenderer.invoke('memory:list', payload),
    save: (payload) => ipcRenderer.invoke('memory:save', payload),
    forgetSession: (payload) => ipcRenderer.invoke('memory:forget-session', payload),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    reviews: () => ipcRenderer.invoke('skills:reviews'),
    review: (payload) => ipcRenderer.invoke('skills:review', payload),
    resolveReview: (payload) => ipcRenderer.invoke('skills:resolve-review', payload),
    curate: (payload) => ipcRenderer.invoke('skills:curate', payload),
    policy: (payload) => ipcRenderer.invoke('skills:policy', payload),
  },
  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
    approve: (payload) => ipcRenderer.invoke('tools:approve', payload),
  },
  quota: {
    get: () => ipcRenderer.invoke('quota:get'),
    sync: (payload) => ipcRenderer.invoke('quota:sync', payload),
    config: (payload) => ipcRenderer.invoke('quota:config', payload),
    login: () => ipcRenderer.invoke('quota:login'),
    logout: () => ipcRenderer.invoke('quota:logout'),
    openSettings: () => ipcRenderer.invoke('quota:open-settings'),
  },
  backend: {
    health: () => ipcRenderer.invoke('backend:health'),
    chat: (payload) => ipcRenderer.invoke('backend:chat', payload),
    startChat: (payload) => {
      const requestId = createRequestId();
      ipcRenderer.send('backend:chat-stream', { requestId, payload });
      return requestId;
    },
    cancelChat: (requestId) => ipcRenderer.invoke('backend:chat-cancel', requestId),
    onChatEvent: (callback) => {
      const listener = (_event, message) => callback(message);
      ipcRenderer.on('backend:chat-event', listener);
      return () => ipcRenderer.removeListener('backend:chat-event', listener);
    },
  },
});
