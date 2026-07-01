// preload for the tab-strip WebContentsView. Bridges the strip UI <-> main:
//   onTabs(cb)     main pushes the current tab list + active id → strip re-renders
//   activate(id)   strip → main: make this tab active
//   close(id)      strip → main: close this tab
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cogyardTabs', {
  onTabs: (cb) => ipcRenderer.on('tabs', (_e, data) => cb(data)),
  activate: (id) => ipcRenderer.send('tab:activate', id),
  close: (id) => ipcRenderer.send('tab:close', id),
});
