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
