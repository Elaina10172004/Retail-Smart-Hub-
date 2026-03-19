const { contextBridge, ipcRenderer } = require('electron');

const platform = typeof process !== 'undefined' && process.platform ? process.platform : 'unknown';
const apiBaseUrl =
  typeof process !== 'undefined' && process.env && typeof process.env.RETAIL_SMART_HUB_API_URL === 'string'
    ? process.env.RETAIL_SMART_HUB_API_URL
    : '';

const desktopShellBridge = Object.freeze({
  platform,
  apiBaseUrl,
  auth: Object.freeze({
    getToken: () => ipcRenderer.invoke('auth:get-token'),
    setToken: (token) => ipcRenderer.invoke('auth:set-token', typeof token === 'string' ? token : ''),
    clearToken: () => ipcRenderer.invoke('auth:clear-token'),
  }),
});

contextBridge.exposeInMainWorld('desktopShell', desktopShellBridge);
