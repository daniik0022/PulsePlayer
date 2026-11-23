const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  searchTracks: (query, source = 'soundcloud') => ipcRenderer.invoke('search-tracks', { query, source }),
  getRelatedTracks: (trackId) => ipcRenderer.invoke('get-related-tracks', trackId),
  getArtistProfile: (artistId) => ipcRenderer.invoke('get-artist-profile', artistId),
  resolveStream: (track) => ipcRenderer.invoke('resolve-stream', track),
  downloadTrack: (track) => ipcRenderer.invoke('download-track', track),
  getLyrics: (track) => ipcRenderer.invoke('get-lyrics', track),
  searchLyricsQuery: (query) => ipcRenderer.invoke('search-lyrics-query', query),
  openDownloadDir: () => ipcRenderer.invoke('open-download-dir'),
  openLocalFiles: () => ipcRenderer.invoke('open-local-files'),
  parseLocalFilePaths: (paths) => ipcRenderer.invoke('parse-local-file-paths', paths),
  getLocalTracksBackup: () => ipcRenderer.invoke('get-local-tracks-backup'),
  saveLocalTracksBackup: (tracks) => ipcRenderer.invoke('save-local-tracks-backup', tracks),
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (e) {}
    return file?.path || '';
  },
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
