// preload for the find-bar WebContentsView. Bridges the find UI <-> main:
//   query(text)    bar → main: run findInPage on the active tab for this query
//   next()/prev()  bar → main: step to the next / previous match
//   close()        bar → main: stopFindInPage + hide the bar (also fires on Esc)
//   onResult(cb)   main → bar: native found-in-page result → update the "n/m" counter
//   onFocus(cb)    main → bar: ⌘F (re)opened → focus + select the input
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cogyardFind', {
  query: (text) => ipcRenderer.send('find:query', text),
  next: () => ipcRenderer.send('find:next'),
  prev: () => ipcRenderer.send('find:prev'),
  close: () => ipcRenderer.send('find:close'),
  onResult: (cb) => ipcRenderer.on('find:result', (_e, data) => cb(data)),
  onFocus: (cb) => ipcRenderer.on('find:focus', () => cb()),
});
