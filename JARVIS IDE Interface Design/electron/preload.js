const { contextBridge, ipcRenderer } = require('electron');

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
  },
});
