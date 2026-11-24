const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  searchTracks: (query, source = 'soundcloud', offset = 0, limit = 25) => ipcRenderer.invoke('search-tracks', { query, source, offset, limit }),
  searchArtists: (query, offset = 0, limit = 25) => ipcRenderer.invoke('search-artists', { query, offset, limit }),
  getRelatedTracks: (trackId) => ipcRenderer.invoke('get-related-tracks', trackId),
  getArtistProfile: (artistId) => ipcRenderer.invoke('get-artist-profile', artistId),
  resolveStream: (track) => ipcRenderer.invoke('resolve-stream', track),
  downloadTrack: (track) => ipcRenderer.invoke('download-track', track),
  getDownloadedTracksInfo: () => ipcRenderer.invoke('get-downloaded-tracks-info'),
  checkTrackDownloaded: (track) => ipcRenderer.invoke('is-track-downloaded', track),
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
  getFavoriteArtistsBackup: () => ipcRenderer.invoke('get-favorite-artists-backup'),
  saveFavoriteArtistsBackup: (artists) => ipcRenderer.invoke('save-favorite-artists-backup', artists),
  getPlaylistsBackup: () => ipcRenderer.invoke('get-playlists-backup'),
  savePlaylistsBackup: (playlists) => ipcRenderer.invoke('save-playlists-backup', playlists),
  isYtDlpAvailable: () => ipcRenderer.invoke('is-ytdlp-available'),
  lastFmGetStatus: () => ipcRenderer.invoke('lastfm-get-status'),
  lastFmStartAuth: () => ipcRenderer.invoke('lastfm-start-auth'),
  lastFmCompleteAuth: (token) => ipcRenderer.invoke('lastfm-complete-auth', token),
  lastFmToggle: (enable) => ipcRenderer.invoke('lastfm-toggle', enable),
  lastFmDisconnect: () => ipcRenderer.invoke('lastfm-disconnect'),
  lastFmNowPlaying: (track) => ipcRenderer.invoke('lastfm-now-playing', track),
  lastFmScrobble: (track, timestamp) => ipcRenderer.invoke('lastfm-scrobble', { track, timestamp }),
  onNavBack: (callback) => ipcRenderer.on('nav-back', () => callback()),
  onNavForward: (callback) => ipcRenderer.on('nav-forward', () => callback()),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close')
});
