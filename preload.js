const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  searchTracks: (query, source = 'soundcloud') => ipcRenderer.invoke('search-tracks', { query, source }),
  getRelatedTracks: (trackId) => ipcRenderer.invoke('get-related-tracks', trackId),
  getArtistProfile: (artistId) => ipcRenderer.invoke('get-artist-profile', artistId),
  resolveStream: (track) => ipcRenderer.invoke('resolve-stream', track),
  downloadTrack: (track) => ipcRenderer.invoke('download-track', track),
  getLyrics: (track) => ipcRenderer.invoke('get-lyrics', track),
  searchLyricsQuery: (query) => ipcRenderer.invoke('search-lyrics-query', query),
  openDownloadDir: () => ipcRenderer.invoke('open-download-dir'),
  updateDiscordRpc: (data) => ipcRenderer.invoke('update-discord-rpc', data),
  clearDiscordRpc: () => ipcRenderer.invoke('clear-discord-rpc'),
  toggleDiscordRpc: (enable) => ipcRenderer.invoke('toggle-discord-rpc', enable),
  getDiscordStatus: () => ipcRenderer.invoke('get-discord-status'),
  getFavoritesBackup: () => ipcRenderer.invoke('get-favorites-backup'),
  saveFavoritesBackup: (favs) => ipcRenderer.invoke('save-favorites-backup', favs),
  isYtDlpAvailable: () => ipcRenderer.invoke('is-ytdlp-available'),
  onNavBack: (callback) => ipcRenderer.on('nav-back', () => callback()),
  onNavForward: (callback) => ipcRenderer.on('nav-forward', () => callback()),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close')
});
