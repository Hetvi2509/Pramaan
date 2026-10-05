// Runs in the window before the page loads. It gives the page one thing it cannot do itself: ask Windows for a folder.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pramaan", {
  selectDirectory: (start) => ipcRenderer.invoke("pramaan:select-directory", start),
});
