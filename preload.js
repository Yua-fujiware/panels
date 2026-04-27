const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: ()        => ipcRenderer.send('window-minimize'),
  maximize: ()        => ipcRenderer.send('window-maximize'),
  close:    ()        => ipcRenderer.send('window-close'),

  // Settings / servers (local JSON)
  getSettings:  ()       => ipcRenderer.invoke('settings-get'),
  saveSettings: (data)   => ipcRenderer.invoke('settings-save', data),
  getServers:   ()       => ipcRenderer.invoke('servers-get'),
  saveServers:  (data)   => ipcRenderer.invoke('servers-save', data),

  // File picker
  openFileDialog: ()     => ipcRenderer.invoke('dialog-open-file'),
  openBgDialog:   ()     => ipcRenderer.invoke('dialog-open-bg'),

  // External links
  openExternal: (url)    => ipcRenderer.send('open-external', url),

  // Internal lightweight browser window
  openInternal: (url)    => ipcRenderer.send('open-internal', url),

  // Panel maintenance
  resetPanelSettings: () => ipcRenderer.invoke('panel-reset-settings'),
  wipePanelDataCache: () => ipcRenderer.invoke('panel-wipe-data-cache'),
  wipeEverything: () => ipcRenderer.invoke('wipe-everything'),
});
