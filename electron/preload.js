const { contextBridge, ipcRenderer } = require('electron');

const langArg = process.argv.find((a) => a.startsWith('--concilia-language='));
const bootLanguage = langArg ? langArg.split('=')[1] : 'en';

contextBridge.exposeInMainWorld('concilia', {
  bootLanguage,
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', filters),
});
