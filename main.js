const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net } = require('electron');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const discordRpc = require('./discordRpc');
const LastFmManager = require('./lastFm');
let lastFm = null;

let mainWindow = null;
let cachedClientId = 'qLcgHhXgeEFFaSolTB9I71LBsqncsD93'; // Fallback default
let lastClientFetchTime = 0;
let isYtDlpAvailable = false;

// 1. Привилегированный протокол для безопасного стриминга локальных треков без отключения webSecurity
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pulse-audio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: false
    }
  }
]);

// 8. Безопасное открытие внешних ссылок (только http/https)
function safeOpenExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(url);
    }
  } catch (e) {}
}

// 5. Валидация объектов треков во всех IPC-хендлерах
function validateTrack(track) {
  if (!track || typeof track !== 'object') return null;
  if (typeof track.title !== 'string' || track.title.length > 500) return null;
  if (typeof track.artist !== 'string' || track.artist.length > 500) return null;
  if (track.permalinkUrl && !/^https?:\/\//i.test(track.permalinkUrl) && track.source !== 'local') return null;
  return track;
}

function checkYtDlp() {
  return new Promise((resolve) => {
    try {
      const p = spawn('yt-dlp', ['--version']);
      p.on('close', (code) => {
        isYtDlpAvailable = (code === 0);
        resolve(isYtDlpAvailable);
      });
      p.on('error', () => {
        isYtDlpAvailable = false;
        resolve(false);
      });
    } catch (e) {
      isYtDlpAvailable = false;
      resolve(false);
    }
  });
}

function getClientIdCachePath() {
  try {
    return path.join(app.getPath('userData'), 'sc_client_id.json');
  } catch (e) {
    return path.join(__dirname, 'sc_client_id.json');
  }
}

function fetchUrl(url, headers = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      return reject(new Error('Too many redirects'));
    }
    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': '*/*',
          ...headers
        }
      };

      const req = client.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          return resolve(fetchUrl(nextUrl, headers, redirectsLeft - 1));
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(12000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function getSoundCloudClientId() {
  const now = Date.now();
  if (cachedClientId && (now - lastClientFetchTime < 1000 * 60 * 60 * 12)) {
    return cachedClientId;
  }

  // 1. Check disk cache
  const cacheFile = getClientIdCachePath();
  try {
    if (fs.existsSync(cacheFile)) {
      const diskData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (diskData && diskData.clientId && (now - diskData.fetchedAt < 1000 * 60 * 60 * 12)) {
        cachedClientId = diskData.clientId;
        lastClientFetchTime = diskData.fetchedAt;
        return cachedClientId;
      }
    }
  } catch (e) {
    console.warn('[SC] Cache read failed:', e.message);
  }

  // 2. Scrape soundcloud.com (max 7 attempts)
  try {
    const html = await fetchUrl('https://soundcloud.com');
    const matches = [...html.matchAll(/<script[^>]+src="([^">]+assets\/[^">]+\.js)"/g)];
    const scriptUrls = matches.map(m => m[1]);

    const maxCheck = Math.min(7, scriptUrls.length);
    for (let i = scriptUrls.length - 1; i >= scriptUrls.length - maxCheck; i--) {
      try {
        const js = await fetchUrl(scriptUrls[i]);
        const m = js.match(/client_id[:=]"([a-zA-Z0-9]{32})"/);
        if (m && m[1]) {
          cachedClientId = m[1];
          lastClientFetchTime = now;
          try {
            fs.writeFileSync(cacheFile, JSON.stringify({ clientId: cachedClientId, fetchedAt: now }), 'utf8');
          } catch (e) {}
          return cachedClientId;
        }
      } catch (err) {
        // Continue scanning previous script
      }
    }
  } catch (err) {
    console.error('[SC] Failed to scrape dynamic client_id, using fallback:', err.message);
  }
  return cachedClientId;
}

function mapTrackData(t) {
  let artwork = t.artwork_url || (t.user && t.user.avatar_url) || '';
  if (artwork) {
    artwork = artwork.replace('-large.', '-t500x500.');
  }
  return {
    id: String(t.id),
    source: 'soundcloud',
    title: t.title || 'Untitled',
    artist: (t.user && t.user.username) || 'Unknown Artist',
    artistId: t.user ? t.user.id : null,
    artistAvatar: (t.user && t.user.avatar_url) ? t.user.avatar_url.replace('-large.', '-t500x500.') : '',
    artistUrl: (t.user && t.user.permalink_url) || '',
    durationMs: t.duration || 0,
    artworkUrl: artwork,
    waveformUrl: t.waveform_url || '',
    permalinkUrl: t.permalink_url || '',
    playbackCount: t.playback_count || 0,
    likesCount: t.likes_count || 0,
    transcodings: (t.media && t.media.transcodings) || []
  };
}

function mapAlbumData(alb, fallbackAvatar = '') {
  let art = alb.artwork_url || '';
  if (art) art = art.replace('-large.', '-t500x500.');
  const mappedTracks = (alb.tracks || []).filter(t => t.title).map(mapTrackData);
  let releaseYear = '';
  if (alb.release_date) {
    releaseYear = String(new Date(alb.release_date).getFullYear());
  } else if (alb.display_date) {
    releaseYear = String(new Date(alb.display_date).getFullYear());
  } else if (alb.created_at) {
    releaseYear = String(new Date(alb.created_at).getFullYear());
  }

  return {
    id: String(alb.id),
    title: alb.title || 'Untitled Album',
    artworkUrl: art || fallbackAvatar,
    trackCount: alb.track_count || mappedTracks.length,
    releaseYear,
    permalinkUrl: alb.permalink_url || '',
    description: alb.description || '',
    likesCount: alb.likes_count || 0,
    tracks: mappedTracks
  };
}

async function searchSoundCloud(query, limit = 25, offset = 0) {
  const cid = await getSoundCloudClientId();
  const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${cid}&limit=${limit}&offset=${offset}`;
  const raw = await fetchUrl(searchUrl, { 'Referer': 'https://soundcloud.com/' });
  const data = JSON.parse(raw);
  const tracks = (data.collection || []).map(mapTrackData);
  const hasMore = Boolean(data.next_href) && tracks.length >= limit;
  return {
    tracks,
    hasMore,
    total: data.total_results || 0,
    offset,
    limit
  };
}

async function searchSoundCloudArtists(query, limit = 25, offset = 0) {
  const cid = await getSoundCloudClientId();
  const searchUrl = `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(query)}&client_id=${cid}&limit=${limit}&offset=${offset}`;
  const raw = await fetchUrl(searchUrl, { 'Referer': 'https://soundcloud.com/' });
  const data = JSON.parse(raw);
  const artists = (data.collection || []).map(u => ({
    id: String(u.id),
    username: u.username || 'Unknown Artist',
    fullName: u.full_name || '',
    avatarUrl: (u.avatar_url || '').replace('-large.', '-t500x500.'),
    city: u.city || '',
    country: u.country || '',
    followersCount: u.followers_count || 0,
    trackCount: u.track_count || 0,
    permalinkUrl: u.permalink_url || '',
    verified: Boolean(u.verified)
  }));
  const hasMore = Boolean(data.next_href) && artists.length >= limit;
  return {
    artists,
    hasMore,
    total: data.total_results || 0,
    offset,
    limit
  };
}

async function getArtistProfile(artistId) {
  const cid = await getSoundCloudClientId();
  const userUrl = `https://api-v2.soundcloud.com/users/${artistId}?client_id=${cid}`;
  const tracksUrl = `https://api-v2.soundcloud.com/users/${artistId}/tracks?client_id=${cid}&limit=50`;
  const albumsUrl = `https://api-v2.soundcloud.com/users/${artistId}/albums?client_id=${cid}&limit=25`;
  const playlistsUrl = `https://api-v2.soundcloud.com/users/${artistId}/playlists_without_albums?client_id=${cid}&limit=25`;

  const [rawUser, rawTracks, rawAlbums, rawPlaylists] = await Promise.all([
    fetchUrl(userUrl, { 'Referer': 'https://soundcloud.com/' }),
    fetchUrl(tracksUrl, { 'Referer': 'https://soundcloud.com/' }).catch(() => '{"collection":[]}'),
    fetchUrl(albumsUrl, { 'Referer': 'https://soundcloud.com/' }).catch(() => '{"collection":[]}'),
    fetchUrl(playlistsUrl, { 'Referer': 'https://soundcloud.com/' }).catch(() => '{"collection":[]}')
  ]);

  const user = JSON.parse(rawUser);
  const tracksData = JSON.parse(rawTracks);
  const albumsData = JSON.parse(rawAlbums);
  const playlistsData = JSON.parse(rawPlaylists);

  let avatar = user.avatar_url || '';
  if (avatar) avatar = avatar.replace('-large.', '-t500x500.');

  let banner = '';
  if (user.visuals && user.visuals.visuals && user.visuals.visuals.length > 0) {
    banner = user.visuals.visuals[0].visual_url || '';
  }

  return {
    artist: {
      id: user.id,
      username: user.username,
      fullName: user.full_name || '',
      avatarUrl: avatar,
      bannerUrl: banner,
      city: user.city || '',
      country: user.country_code || '',
      followersCount: user.followers_count || 0,
      trackCount: user.track_count || 0,
      playlistCount: user.playlist_count || 0,
      likesCount: user.likes_count || 0,
      description: user.description || '',
      permalinkUrl: user.permalink_url || '',
      verified: !!user.verified
    },
    tracks: (tracksData.collection || []).map(mapTrackData),
    albums: (albumsData.collection || []).map(a => mapAlbumData(a, avatar)),
    playlists: (playlistsData.collection || []).map(p => mapAlbumData(p, avatar))
  };
}

async function getRelatedTracks(trackId, limit = 25) {
  if (!trackId) return [];
  const cid = await getSoundCloudClientId();
  try {
    const url = `https://api-v2.soundcloud.com/tracks/${trackId}/related?client_id=${cid}&limit=${limit}`;
    const raw = await fetchUrl(url, { 'Referer': 'https://soundcloud.com/' });
    const data = JSON.parse(raw);
    const collection = Array.isArray(data.collection) ? data.collection : [];
    return collection.filter(t => t && t.title).map(mapTrackData);
  } catch (err) {
    try {
      const stationUrl = `https://api-v2.soundcloud.com/stations/soundcloud:track:${trackId}/tracks?client_id=${cid}&limit=${limit}`;
      const rawStation = await fetchUrl(stationUrl, { 'Referer': 'https://soundcloud.com/' });
      const dataStation = JSON.parse(rawStation);
      const collection = Array.isArray(dataStation.collection) ? dataStation.collection : [];
      return collection.filter(t => t && t.title).map(mapTrackData);
    } catch (e2) {
      console.warn(`[WAVE] Related tracks fetch failed for track ${trackId}:`, err.message);
      return [];
    }
  }
}

function parseAudioFile(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch (e) {
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  const validExts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.wma'];
  if (!validExts.includes(ext)) return null;

  const baseName = path.basename(filePath, ext);
  let artist = 'Локальный трек';
  let title = baseName;
  let artworkUrl = '';

  if (baseName.includes(' - ')) {
    const parts = baseName.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }

  // ID3 tag extraction for MP3 / Audio
  try {
    const fd = fs.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(10);
    fs.readSync(fd, headerBuf, 0, 10, 0);

    if (headerBuf.toString('ascii', 0, 3) === 'ID3') {
      const ver = headerBuf[3];
      const tagSize = ((headerBuf[6] & 0x7f) << 21) |
                      ((headerBuf[7] & 0x7f) << 14) |
                      ((headerBuf[8] & 0x7f) << 7) |
                      (headerBuf[9] & 0x7f);

      const maxRead = Math.min(tagSize, 256 * 1024);
      const tagBuf = Buffer.alloc(maxRead);
      fs.readSync(fd, tagBuf, 0, maxRead, 10);

      let offset = 0;
      while (offset < maxRead - 10) {
        const frameId = tagBuf.toString('ascii', offset, offset + 4);
        if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

        let frameSize = 0;
        if (ver === 4) {
          frameSize = ((tagBuf[offset + 4] & 0x7f) << 21) |
                      ((tagBuf[offset + 5] & 0x7f) << 14) |
                      ((tagBuf[offset + 6] & 0x7f) << 7) |
                      (tagBuf[offset + 7] & 0x7f);
        } else {
          frameSize = tagBuf.readUInt32BE(offset + 4);
        }

        if (frameSize <= 0 || offset + 10 + frameSize > maxRead) break;
        const frameData = tagBuf.slice(offset + 10, offset + 10 + frameSize);

        const decodeText = (buf) => {
          if (buf.length < 2) return '';
          const enc = buf[0];
          const content = buf.slice(1);
          if (enc === 0) return content.toString('latin1').replace(/\0/g, '').trim();
          if (enc === 1) return content.toString('utf16le').replace(/\0/g, '').trim();
          if (enc === 2) return content.toString('utf16be').replace(/\0/g, '').trim();
          if (enc === 3) return content.toString('utf8').replace(/\0/g, '').trim();
          return content.toString('utf8').replace(/\0/g, '').trim();
        };

        if (frameId === 'TIT2') {
          const t = decodeText(frameData);
          if (t) title = t;
        } else if (frameId === 'TPE1') {
          const a = decodeText(frameData);
          if (a) artist = a;
        } else if (frameId === 'APIC' && !artworkUrl && frameSize < 1024 * 1024) {
          try {
            const enc = frameData[0];
            let pos = 1;
            while (pos < frameData.length && frameData[pos] !== 0) pos++;
            const mime = frameData.toString('ascii', 1, pos) || 'image/jpeg';
            pos++; // skip null
            if (pos < frameData.length) {
              pos++; // skip type
              if (enc === 1 || enc === 2) {
                while (pos < frameData.length - 1 && !(frameData[pos] === 0 && frameData[pos + 1] === 0)) pos += 2;
                pos += 2;
              } else {
                while (pos < frameData.length && frameData[pos] !== 0) pos++;
                pos++;
              }
              if (pos < frameData.length) {
                const imgBuf = frameData.slice(pos);
                artworkUrl = `data:${mime};base64,${imgBuf.toString('base64')}`;
              }
            }
          } catch (e) {}
        }

        offset += 10 + frameSize;
      }
    }
    fs.closeSync(fd);
  } catch (e) {}

  const hash = crypto.createHash('md5').update(filePath.toLowerCase()).digest('hex').slice(0, 12);

  return {
    id: 'local_' + hash,
    source: 'local',
    title: title || baseName,
    artist: artist || 'Локальный трек',
    filePath,
    durationMs: 0,
    artworkUrl,
    permalinkUrl: '',
    playbackCount: 0,
    likesCount: 0,
    transcodings: []
  };
}

async function resolveSoundCloudStream(track) {
  const cid = await getSoundCloudClientId();
  let tc = track.transcodings || [];
  if (!tc.length && track.id) {
    try {
      const trackRaw = await fetchUrl(`https://api-v2.soundcloud.com/tracks/${track.id}?client_id=${cid}`, { 'Referer': 'https://soundcloud.com/' });
      const parsed = JSON.parse(trackRaw);
      if (parsed.media && parsed.media.transcodings) {
        tc = parsed.media.transcodings;
        track.transcodings = tc;
      }
    } catch (e) {
      console.warn('[SC] Failed to re-fetch track transcodings:', e.message);
    }
  }

  if (!tc.length) {
    throw new Error('У трека отсутствуют потоки транскодинга');
  }

  const target = tc.find(t => t.format && t.format.protocol === 'progressive')
    || tc.find(t => t.format && t.format.protocol === 'hls')
    || tc[0];

  const reqUrl = `${target.url}?client_id=${cid}`;
  const raw = await fetchUrl(reqUrl, { 'Referer': 'https://soundcloud.com/' });
  const json = JSON.parse(raw);

  return {
    streamUrl: json.url,
    protocol: target.format ? target.format.protocol : 'hls',
    mimeType: target.format ? target.format.mime_type : 'audio/mpeg'
  };
}

async function searchYouTube(query, limit = 25, offset = 0) {
  if (!isYtDlpAvailable) return { tracks: [], hasMore: false, total: 0, offset, limit };
  const maxFetch = offset + limit;
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', [
      `ytsearch${maxFetch}:${query}`,
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings'
    ]);

    let stdout = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        return resolve({ tracks: [], hasMore: false, total: 0, offset, limit });
      }
      try {
        const parsed = JSON.parse(stdout);
        const allResults = (parsed.entries || []).map(e => ({
          id: String(e.id),
          source: 'youtube',
          title: e.title || 'Untitled',
          artist: e.uploader || e.channel || 'YouTube',
          artistId: null,
          artistAvatar: '',
          durationMs: (e.duration || 0) * 1000,
          artworkUrl: (e.thumbnails && e.thumbnails.length) ? e.thumbnails[e.thumbnails.length - 1].url : '',
          permalinkUrl: (e.webpage_url && /^https?:\/\//i.test(e.webpage_url)) ? e.webpage_url : (e.id ? `https://www.youtube.com/watch?v=${e.id}` : (e.url || '')),
          playbackCount: e.view_count || 0,
          likesCount: 0,
          transcodings: []
        }));
        const sliced = allResults.slice(offset, offset + limit);
        const hasMore = allResults.length >= maxFetch;
        resolve({
          tracks: sliced,
          hasMore,
          total: allResults.length,
          offset,
          limit
        });
      } catch (err) {
        resolve({ tracks: [], hasMore: false, total: 0, offset, limit });
      }
    });
    proc.on('error', () => resolve({ tracks: [], hasMore: false, total: 0, offset, limit }));
  });
}

async function resolveYouTubeStream(track) {
  if (!isYtDlpAvailable) {
    throw new Error('yt-dlp не установлен в системе (добавьте yt-dlp в PATH)');
  }
  let targetUrl = track.permalinkUrl;
  if (!targetUrl || !/^https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be)\//i.test(targetUrl)) {
    if (track.id) {
      targetUrl = `https://www.youtube.com/watch?v=${track.id}`;
    } else {
      throw new Error('Недопустимый URL YouTube');
    }
  }
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '-g',
      targetUrl
    ]);

    let stdout = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        const streamUrl = stdout.trim().split(/\r?\n/)[0];
        resolve({
          streamUrl,
          protocol: 'progressive',
          mimeType: 'audio/webm'
        });
      } else {
        reject(new Error('Не удалось извлечь поток с YouTube'));
      }
    });
    proc.on('error', (err) => reject(new Error('yt-dlp не найден: ' + err.message)));
  });
}

function getDownloadDir() {
  const docsDir = (typeof app !== 'undefined' && app && app.getPath)
    ? app.getPath('documents')
    : path.join(os.homedir(), 'Documents');
  const dir = path.join(docsDir, 'SC-Player');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Auto-migrate from legacy Downloads/SC-Player if needed
  try {
    const oldDir = path.join(os.homedir(), 'Downloads', 'SC-Player');
    if (fs.existsSync(oldDir)) {
      const items = fs.readdirSync(oldDir);
      for (const item of items) {
        const src = path.join(oldDir, item);
        const dest = path.join(dir, item);
        if (!fs.existsSync(dest)) {
          try {
            fs.renameSync(src, dest);
          } catch (err) {
            try { fs.copyFileSync(src, dest); } catch (e) {}
          }
        }
      }
    }
  } catch (e) {}

  return dir;
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').substring(0, 100);
}

function findDownloadedTrackFile(track) {
  if (!track) return null;
  const downloadDir = getDownloadDir();
  const safeArtist = sanitizeFilename(track.artist || 'Unknown');
  const safeTitle = sanitizeFilename(track.title || 'Untitled');
  const directPath = path.join(downloadDir, `${safeArtist} - ${safeTitle}.mp3`);
  try {
    if (fs.existsSync(directPath)) {
      const stat = fs.statSync(directPath);
      if (stat.size >= 10240) return directPath;
    }
  } catch (e) {}

  try {
    if (fs.existsSync(downloadDir)) {
      const files = fs.readdirSync(downloadDir);
      const targetBase = `${safeArtist} - ${safeTitle}`.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (targetBase.length > 0) {
        for (const file of files) {
          if (file.toLowerCase().endsWith('.mp3')) {
            const fileBase = file.slice(0, -4).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
            if (fileBase === targetBase) {
              const full = path.join(downloadDir, file);
              const stat = fs.statSync(full);
              if (stat.size >= 10240) return full;
            }
          }
        }
      }
    }
  } catch (e) {}
  return null;
}

function downloadHttpFile(initialUrl, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function attempt(url, redirectsLeft) {
      if (redirectsLeft <= 0) {
        return reject(new Error('Слишком много редиректов при скачивании аудио'));
      }
      try {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*'
          }
        };

        const req = client.request(options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = new URL(res.headers.location, url).toString();
            return attempt(nextUrl, redirectsLeft - 1);
          }

          if (res.statusCode !== 200) {
            return reject(new Error(`CDN вернул HTTP статус ${res.statusCode}`));
          }

          const ct = (res.headers['content-type'] || '').toLowerCase();
          if (ct.includes('text/html')) {
            return reject(new Error('CDN отдал HTML-страницу вместо аудиофайла'));
          }

          const file = fs.createWriteStream(destPath);
          res.pipe(file);

          file.on('finish', () => {
            file.close(() => {
              try {
                const stat = fs.statSync(destPath);
                if (stat.size < 10240) {
                  fs.unlink(destPath, () => {});
                  return reject(new Error(`Файл повреждён (размер ${stat.size} байт)`));
                }
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          });

          file.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        });

        req.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });

        req.setTimeout(30000, () => {
          req.destroy();
          fs.unlink(destPath, () => {});
          reject(new Error('Таймаут скачивания аудиопотока'));
        });

        req.end();
      } catch (err) {
        fs.unlink(destPath, () => {});
        reject(err);
      }
    }
    attempt(initialUrl, maxRedirects);
  });
}

async function downloadTrack(track) {
  const downloadDir = getDownloadDir();
  const safeArtist = sanitizeFilename(track.artist || 'Unknown');
  const safeTitle = sanitizeFilename(track.title || 'Untitled');
  const destPath = path.join(downloadDir, `${safeArtist} - ${safeTitle}.mp3`);
  const partPath = destPath + '.part';

  if (fs.existsSync(destPath)) {
    try {
      const stat = fs.statSync(destPath);
      if (stat.size >= 10240) {
        return { success: true, path: destPath, message: 'Файл уже загружен' };
      }
      fs.unlinkSync(destPath);
    } catch (e) {}
  }

  // Clean stale partial downloads
  if (fs.existsSync(partPath)) {
    try { fs.unlinkSync(partPath); } catch (e) {}
  }

  if (track.source === 'local') {
    if (track.filePath && fs.existsSync(track.filePath)) {
      return { success: true, path: track.filePath, message: 'Локальный файл уже сохранён на диске' };
    }
    return { success: false, message: 'Локальный файл не найден на диске' };
  }

  if (track.source === 'soundcloud') {
    try {
      const resolved = await resolveSoundCloudStream(track);
      if (!resolved.streamUrl || !/^https?:\/\//i.test(resolved.streamUrl)) {
        throw new Error('Недопустимый URL потока');
      }
      if (resolved.protocol === 'progressive') {
        await downloadHttpFile(resolved.streamUrl, partPath);
        fs.renameSync(partPath, destPath);
        return { success: true, path: destPath };
      } else {
        await new Promise((resolve, reject) => {
          const proc = spawn('ffmpeg', [
            '-y',
            '-i', resolved.streamUrl,
            '-c:a', 'libmp3lame',
            '-q:a', '2',
            partPath
          ]);
          proc.on('close', (code) => {
            if (code === 0) {
              try {
                const stat = fs.statSync(partPath);
                if (stat.size < 10240) {
                  fs.unlink(partPath, () => {});
                  return reject(new Error('Файл повреждён при записи ffmpeg'));
                }
                fs.renameSync(partPath, destPath);
                resolve({ success: true, path: destPath });
              } catch (e) {
                reject(e);
              }
            } else {
              fs.unlink(partPath, () => {});
              reject(new Error(`ffmpeg завершился с кодом ${code}`));
            }
          });
          proc.on('error', (err) => {
            fs.unlink(partPath, () => {});
            reject(err);
          });
        });
        return { success: true, path: destPath };
      }
    } catch (scErr) {
      console.warn('[SC Download] Поток SoundCloud не удалось обработать напрямую, фоллбэк на yt-dlp:', scErr.message);
      let targetUrl = track.permalinkUrl;
      if (!targetUrl || !/^https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:soundcloud\.com|snd\.sc)/i.test(targetUrl)) {
        targetUrl = track.id ? `https://api.soundcloud.com/tracks/${track.id}` : null;
      }
      if (!targetUrl) throw new Error('Не удалось определить адрес трека SoundCloud');
      await downloadWithYtDlp(targetUrl, destPath);
      return { success: true, path: destPath };
    }
  } else {
    let targetUrl = track.permalinkUrl;
    if (!targetUrl || !/^https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be|soundcloud\.com)/i.test(targetUrl)) {
      if (track.id) {
        targetUrl = (track.source === 'soundcloud' || /^\d+$/.test(track.id))
          ? `https://api.soundcloud.com/tracks/${track.id}`
          : `https://www.youtube.com/watch?v=${track.id}`;
      }
    }
    if (!targetUrl) throw new Error('Не удалось определить адрес трека');
    await downloadWithYtDlp(targetUrl, destPath);
    return { success: true, path: destPath };
  }
}

function sanitizeForLyrics(str) {
  if (!str) return '';
  return str
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\b(official\s*(music\s*video|audio|video|track)?|prod(\.|ucer)?(\s*by)?|feat(\.)?|ft(\.)?|w\/|remix|slowed(\s*\+\s*reverb)?|sped\s*up|bass\s*boosted|edit|records|topic)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLooseMatch(actual, expected) {
  if (!actual || !expected) return false;
  const a = actual.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const b = expected.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (a.length === 0 || b.length === 0) return false;
  return a.includes(b) || b.includes(a);
}

async function searchLrclibStructured(artistName, trackName) {
  if (!trackName || trackName.length < 1) return null;
  try {
    let url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(trackName)}`;
    if (artistName && artistName.length > 1) {
      url += `&artist_name=${encodeURIComponent(artistName)}`;
    }
    const raw = await fetchUrl(url, { 'User-Agent': 'PulsePlayer/1.0' });
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length > 0) {
      const valid = artistName
        ? list.filter(item => isLooseMatch(item.artistName, artistName) && isLooseMatch(item.trackName, trackName))
        : list.filter(item => isLooseMatch(item.trackName, trackName));

      if (valid.length > 0) {
        const match = valid.find(l => l.syncedLyrics) || valid.find(l => l.plainLyrics) || valid[0];
        if (match.syncedLyrics || match.plainLyrics) {
          return {
            syncedLyrics: match.syncedLyrics || null,
            plainLyrics: match.plainLyrics || null,
            instrumental: !!match.instrumental,
            artist: match.artistName,
            track: match.trackName,
            source: match.syncedLyrics ? `Караоке (${match.artistName})` : `LRCLIB (${match.artistName})`
          };
        }
      }
    }
  } catch (e) {}
  return null;
}

async function searchLrclibFuzzy(query, expectedArtist, expectedTitle) {
  if (!query || query.length < 2) return null;
  try {
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const raw = await fetchUrl(searchUrl, { 'User-Agent': 'PulsePlayer/1.0' });
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length > 0) {
      // STRICT FILTER: must match artist and title
      const valid = list.filter(item => {
        const artistOk = expectedArtist ? isLooseMatch(item.artistName, expectedArtist) : true;
        const titleOk = expectedTitle ? isLooseMatch(item.trackName, expectedTitle) : true;
        return artistOk && titleOk;
      });

      if (valid.length > 0) {
        const match = valid.find(l => l.syncedLyrics) || valid.find(l => l.plainLyrics) || valid[0];
        if (match.syncedLyrics || match.plainLyrics) {
          return {
            syncedLyrics: match.syncedLyrics || null,
            plainLyrics: match.plainLyrics || null,
            instrumental: !!match.instrumental,
            artist: match.artistName,
            track: match.trackName,
            source: match.syncedLyrics ? `Караоке (${match.artistName})` : `LRCLIB (${match.artistName})`
          };
        }
      }
    }
  } catch (e) {}
  return null;
}

async function searchLyricsManual(query) {
  if (!query || typeof query !== 'string') return null;
  const rawQ = query.trim();
  const cleaned = sanitizeForLyrics(rawQ);
  const queriesToTry = [rawQ, cleaned].filter(q => q && q.length >= 2);
  const uniqueQueries = [...new Set(queriesToTry)];

  for (const q of uniqueQueries) {
    try {
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
      const raw = await fetchUrl(searchUrl, { 'User-Agent': 'PulsePlayer/1.0' });
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        const match = list.find(l => l.syncedLyrics) || list.find(l => l.plainLyrics) || list[0];
        if (match && (match.syncedLyrics || match.plainLyrics || match.instrumental)) {
          return {
            syncedLyrics: match.syncedLyrics || null,
            plainLyrics: match.plainLyrics || null,
            instrumental: !!match.instrumental,
            artist: match.artistName,
            track: match.trackName,
            source: match.syncedLyrics ? `LRCLIB (Синхронизирован)` : (match.plainLyrics ? `LRCLIB (Обычный текст)` : `LRCLIB`)
          };
        }
      }
    } catch (e) {}
  }
  return null;
}

async function fetchLyrics(track) {
  const rawTitle = track.title || '';
  const rawArtist = track.artist || '';

  const cleanArt = sanitizeForLyrics(rawArtist);
  const cleanTit = sanitizeForLyrics(rawTitle);

  let partArt = '';
  let partTit = '';
  if (rawTitle.includes(' - ')) {
    const parts = rawTitle.split(' - ');
    partArt = sanitizeForLyrics(parts[0]);
    partTit = sanitizeForLyrics(parts.slice(1).join(' '));
  }

  const candidatePairs = [];
  if (partArt && partTit) {
    candidatePairs.push({ artist: partArt, title: partTit });
    candidatePairs.push({ artist: cleanArt, title: partTit });
  }
  if (cleanArt && cleanTit) {
    candidatePairs.push({ artist: cleanArt, title: cleanTit });
  }

  // 1. Structured search with strict match
  for (const pair of candidatePairs) {
    const res = await searchLrclibStructured(pair.artist, pair.title);
    if (res) return res;
  }

  // 2. Fuzzy search with strict verification
  for (const pair of candidatePairs) {
    const q = `${pair.artist} ${pair.title}`.trim();
    const res = await searchLrclibFuzzy(q, pair.artist, pair.title);
    if (res) return res;
  }

  // 3. Fallback: lyrics.ovh
  for (const pair of candidatePairs) {
    try {
      const ovhUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(pair.artist)}/${encodeURIComponent(pair.title)}`;
      const raw = await fetchUrl(ovhUrl);
      const res = JSON.parse(raw);
      if (res.lyrics) {
        return {
          syncedLyrics: null,
          plainLyrics: res.lyrics.trim(),
          instrumental: false,
          artist: pair.artist,
          track: pair.title,
          source: `Lyrics.ovh (${pair.artist})`
        };
      }
    } catch (e) {}
  }

  return {
    syncedLyrics: null,
    plainLyrics: null,
    instrumental: false,
    source: null
  };
}

function downloadWithYtDlp(url, destPath) {
  if (!isYtDlpAvailable) {
    return Promise.reject(new Error('yt-dlp не установлен в системе (добавьте yt-dlp в PATH)'));
  }
  const isAllowed = /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be|soundcloud\.com|snd\.sc|googlevideo\.com)/i.test(url);
  if (!url || !isAllowed) {
    return Promise.reject(new Error('Недопустимый URL для yt-dlp'));
  }
  const cleanDest = destPath.replace(/\.part$/, '');
  const outTemplate = cleanDest.endsWith('.mp3') ? cleanDest.slice(0, -4) + '.%(ext)s' : cleanDest + '.%(ext)s';

  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--no-warnings',
      '-o', outTemplate,
      url
    ]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          if (fs.existsSync(cleanDest) && fs.statSync(cleanDest).size >= 10240) {
            resolve({ success: true, path: cleanDest });
          } else {
            if (fs.existsSync(cleanDest)) fs.unlinkSync(cleanDest);
            reject(new Error('yt-dlp создал повреждённый файл (< 10 KB)'));
          }
        } catch (e) {
          reject(e);
        }
      } else {
        if (fs.existsSync(cleanDest)) fs.unlinkSync(cleanDest);
        const errMsg = stderr.trim()
          ? (stderr.split('\n').filter(l => l.includes('ERROR:') || l.includes('Error')).pop() || stderr.slice(-300))
          : `код ${code}`;
        reject(new Error(`yt-dlp: ${errMsg.replace(/^ERROR:\s*/i, '').trim()}`));
      }
    });
    proc.on('error', (err) => {
      if (fs.existsSync(cleanDest)) fs.unlinkSync(cleanDest);
      reject(new Error(`Ошибка запуска yt-dlp: ${err.message}`));
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 650,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0c0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  // 2. setWindowOpenHandler — блокировка window.open (открытие только в системном браузере)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });

  // 3. will-navigate — запрет перехода по ссылкам внутри окна Electron
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      safeOpenExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') {
      mainWindow.webContents.send('nav-back');
    } else if (cmd === 'browser-forward') {
      mainWindow.webContents.send('nav-forward');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Безопасный стриминг локальных треков через pulse-audio протокол с полной поддержкой HTTP Range (206 Partial Content)
  protocol.handle('pulse-audio', async (request) => {
    try {
      let rawPath = request.url.replace(/^pulse-audio:\/\/(?:stream)?\/?/i, '');
      let filePath = decodeURIComponent(rawPath);
      if (process.platform === 'win32' && filePath.startsWith('/')) {
        filePath = filePath.slice(1);
      }
      filePath = path.normalize(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const allowed = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.wma'];
      if (!allowed.includes(ext) || !fs.existsSync(filePath)) {
        console.warn('[PULSE-AUDIO] Файл не найден или недопустим:', filePath);
        return new Response('Forbidden', { status: 403 });
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const rangeHeader = request.headers.get('range');

      const mimeTypes = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.opus': 'audio/opus',
        '.wma': 'audio/x-ms-wma'
      };
      const contentType = mimeTypes[ext] || 'audio/mpeg';

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
          const chunkSize = (end - start) + 1;

          const stream = fs.createReadStream(filePath, { start, end });
          return new Response(Readable.toWeb(stream), {
            status: 206,
            statusText: 'Partial Content',
            headers: {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': contentType,
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
              'Access-Control-Allow-Headers': '*'
            }
          });
        }
      }

      const stream = fs.createReadStream(filePath);
      return new Response(Readable.toWeb(stream), {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Length': String(fileSize),
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    } catch (e) {
      console.error('[PULSE-AUDIO] Ошибка обработки:', e);
      return new Response('Internal Server Error', { status: 500 });
    }
  });

  await checkYtDlp();
  createWindow();
  discordRpc.init();
  lastFm = new LastFmManager();

  // IPC Handlers
  ipcMain.handle('search-tracks', async (_, { query, source, offset = 0, limit = 25 }) => {
    if (source === 'youtube') return await searchYouTube(query, limit, offset);
    return await searchSoundCloud(query, limit, offset);
  });

  ipcMain.handle('search-artists', async (_, { query, offset = 0, limit = 25 }) => {
    return await searchSoundCloudArtists(query, limit, offset);
  });

  ipcMain.handle('get-artist-profile', async (_, artistId) => {
    return await getArtistProfile(artistId);
  });

  ipcMain.handle('get-related-tracks', async (_, trackId) => {
    return await getRelatedTracks(trackId);
  });

  // 6. Защита resolve-stream от чтения произвольных файлов и валидация
  ipcMain.handle('resolve-stream', async (_, track) => {
    const valid = validateTrack(track);
    if (!valid) throw new Error('Недопустимый объект трека');

    if (valid.source === 'local') {
      const p = valid.filePath || '';
      const ext = path.extname(p).toLowerCase();
      const allowed = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.wma'];
      if (!allowed.includes(ext) || !fs.existsSync(p)) {
        throw new Error('Недопустимый путь к файлу');
      }
      return {
        streamUrl: `pulse-audio://stream/${encodeURIComponent(p.replace(/\\/g, '/'))}`,
        protocol: 'progressive',
        mimeType: 'audio/mpeg',
        isLocal: true,
        localPath: p
      };
    }

    // Автоматическая загрузка трека с локального диска, если он скачан
    const downloadedPath = findDownloadedTrackFile(valid);
    if (downloadedPath) {
      return {
        streamUrl: `pulse-audio://stream/${encodeURIComponent(downloadedPath.replace(/\\/g, '/'))}`,
        protocol: 'progressive',
        mimeType: 'audio/mpeg',
        isLocal: true,
        localPath: downloadedPath
      };
    }

    if (valid.source === 'youtube') return await resolveYouTubeStream(valid);
    return await resolveSoundCloudStream(valid);
  });

  ipcMain.handle('open-local-files', async () => {
    if (!mainWindow) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Импорт аудиофайлов в PulsePlayer',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Аудиофайлы (*.mp3, *.wav, *.ogg, *.flac, *.m4a, *.aac)', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return [];
    return res.filePaths.map(parseAudioFile).filter(Boolean);
  });

  ipcMain.handle('parse-local-file-paths', async (_, filePaths) => {
    if (!Array.isArray(filePaths)) return [];
    return filePaths.map(parseAudioFile).filter(Boolean);
  });

  ipcMain.handle('get-local-tracks-backup', () => {
    try {
      const p = path.join(app.getPath('userData'), 'local_tracks.json');
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) {
      console.warn('Failed to read local tracks backup:', e);
    }
    return [];
  });

  ipcMain.handle('save-local-tracks-backup', async (_, tracks) => {
    if (!Array.isArray(tracks)) return false;
    try {
      const p = path.join(app.getPath('userData'), 'local_tracks.json');
      fs.writeFileSync(p + '.tmp', JSON.stringify(tracks, null, 2), 'utf8');
      fs.renameSync(p + '.tmp', p);
      return true;
    } catch (e) {
      console.warn('Failed to save local tracks backup:', e);
      return false;
    }
  });

  ipcMain.handle('download-track', async (_, track) => {
    const valid = validateTrack(track);
    if (!valid) throw new Error('Недопустимый объект трека');
    return await downloadTrack(valid);
  });

  ipcMain.handle('get-downloaded-tracks-info', async () => {
    try {
      const downloadDir = getDownloadDir();
      if (!fs.existsSync(downloadDir)) return [];
      const files = fs.readdirSync(downloadDir);
      const result = [];
      for (const file of files) {
        if (file.toLowerCase().endsWith('.mp3')) {
          const filePath = path.join(downloadDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.size >= 10240) {
              const baseName = file.slice(0, -4);
              const baseKey = baseName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
              result.push({
                fileName: file,
                baseKey,
                baseName,
                filePath,
                size: stat.size
              });
            }
          } catch (e) {}
        }
      }
      return result;
    } catch (e) {
      console.warn('Failed to read downloaded tracks:', e);
      return [];
    }
  });

  ipcMain.handle('is-track-downloaded', async (_, track) => {
    const valid = validateTrack(track);
    if (!valid) return false;
    return Boolean(findDownloadedTrackFile(valid));
  });

  ipcMain.handle('get-lyrics', async (_, track) => {
    const valid = validateTrack(track);
    if (!valid) return { error: 'Invalid track data' };
    return await fetchLyrics(valid);
  });

  ipcMain.handle('search-lyrics-query', async (_, query) => {
    if (typeof query !== 'string') return [];
    return await searchLyricsManual(query);
  });

  ipcMain.handle('open-download-dir', () => {
    const dir = getDownloadDir();
    shell.openPath(dir);
    return dir;
  });

  // Discord RPC Handlers & Online Artwork Cache
  const artworkCache = new Map();

  async function resolveOnlineArtwork(track) {
    if (!track) return null;
    const cleanArtist = (track.artist || '').replace(/\s*\(.*\)/g, '').trim();
    const cleanTitle = (track.title || '').replace(/\s*\(.*\)/g, '').trim();
    const key = `${cleanArtist.toLowerCase()}:::${cleanTitle.toLowerCase()}`;
    if (artworkCache.has(key)) return artworkCache.get(key);

    const query = `${cleanArtist} ${cleanTitle}`.trim();
    if (!query || query.length < 2) return null;

    try {
      const raw = await fetchUrl(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      });
      const json = JSON.parse(raw);
      if (json.results && json.results.length > 0) {
        const art = json.results[0].artworkUrl100 ? json.results[0].artworkUrl100.replace('100x100bb', '512x512bb') : null;
        if (art && art.startsWith('http')) {
          artworkCache.set(key, art);
          return art;
        }
      }
    } catch (e) {}

    artworkCache.set(key, null);
    return null;
  }

  ipcMain.handle('update-discord-rpc', async (_, data) => {
    if (!data || typeof data !== 'object') return discordRpc.getStatus();
    if (data.track) {
      const valid = validateTrack(data.track);
      if (!valid) return discordRpc.getStatus();
      data.track = valid;
    }
    if (data.track && (!data.track.artworkUrl || !data.track.artworkUrl.startsWith('http'))) {
      const cleanArtist = (data.track.artist || '').replace(/\s*\(.*\)/g, '').trim();
      const cleanTitle = (data.track.title || '').replace(/\s*\(.*\)/g, '').trim();
      const key = `${cleanArtist.toLowerCase()}:::${cleanTitle.toLowerCase()}`;

      if (artworkCache.has(key)) {
        const cached = artworkCache.get(key);
        if (cached) data.track.remoteArtworkUrl = cached;
      } else {
        // Resolve online cover in background without blocking RPC delivery
        resolveOnlineArtwork(data.track).then(art => {
          if (art && discordRpc.lastState?.track && discordRpc.lastState.track.id === data.track.id) {
            discordRpc.lastState.track.remoteArtworkUrl = art;
            discordRpc.updateActivity(discordRpc.lastState).catch(() => {});
          }
        }).catch(() => {});
      }
    }

    await discordRpc.updateActivity(data);
    return discordRpc.getStatus();
  });

  ipcMain.handle('clear-discord-rpc', async () => {
    await discordRpc.clearActivity();
    return discordRpc.getStatus();
  });

  ipcMain.handle('toggle-discord-rpc', async (_, enable) => {
    discordRpc.setEnabled(enable);
    return discordRpc.getStatus();
  });

  ipcMain.handle('get-discord-status', () => {
    return discordRpc.getStatus();
  });

  ipcMain.handle('is-ytdlp-available', () => {
    return isYtDlpAvailable;
  });

  // Last.fm Integration Handlers
  ipcMain.handle('lastfm-get-status', () => {
    return lastFm ? lastFm.getStatus() : { connected: false, enabled: false, username: null };
  });

  ipcMain.handle('lastfm-start-auth', async () => {
    if (!lastFm) return { success: false, error: 'LastFm not initialized' };
    return await lastFm.startAuth();
  });

  ipcMain.handle('lastfm-complete-auth', async (_, token) => {
    if (!lastFm) return { success: false, error: 'LastFm not initialized' };
    return await lastFm.completeAuth(token);
  });

  ipcMain.handle('lastfm-toggle', async (_, enable) => {
    if (!lastFm) return { connected: false, enabled: false, username: null };
    return lastFm.toggle(enable);
  });

  ipcMain.handle('lastfm-disconnect', async () => {
    if (!lastFm) return { connected: false, enabled: false, username: null };
    return lastFm.disconnect();
  });

  ipcMain.handle('lastfm-now-playing', async (_, track) => {
    if (!lastFm) return false;
    const valid = validateTrack(track);
    if (!valid) return false;
    await lastFm.updateNowPlaying(valid);
    return true;
  });

  ipcMain.handle('lastfm-scrobble', async (_, { track, timestamp } = {}) => {
    if (!lastFm) return { success: false };
    const valid = validateTrack(track);
    if (!valid) return { success: false, error: 'Invalid track data' };
    const ts = (typeof timestamp === 'number' && timestamp > 0) ? timestamp : Math.floor(Date.now() / 1000);
    return await lastFm.scrobble(valid, ts);
  });

  ipcMain.handle('get-favorites-backup', () => {
    try {
      const userBackup = path.join(app.getPath('userData'), 'favorites_autobackup.json');
      if (fs.existsSync(userBackup)) {
        return JSON.parse(fs.readFileSync(userBackup, 'utf-8'));
      }
      const rootBackup = path.join(__dirname, 'favorites_backup.json');
      if (fs.existsSync(rootBackup)) {
        return JSON.parse(fs.readFileSync(rootBackup, 'utf-8'));
      }
    } catch (e) {
      console.warn('Failed to read favorites backup:', e);
    }
    return [];
  });

  ipcMain.handle('save-favorites-backup', async (_, favs) => {
    if (!Array.isArray(favs)) return false;
    try {
      const userDataDir = app.getPath('userData');
      const backupPath = path.join(userDataDir, 'favorites_autobackup.json');
      const tmpPath = backupPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(favs, null, 2), 'utf8');
      fs.renameSync(tmpPath, backupPath);

      const rootBackup = path.join(__dirname, 'favorites_backup.json');
      try {
        fs.writeFileSync(rootBackup + '.tmp', JSON.stringify(favs, null, 2), 'utf8');
        fs.renameSync(rootBackup + '.tmp', rootBackup);
      } catch (e) {}
      return true;
    } catch (err) {
      console.warn('[BACKUP] Failed to save favorites:', err.message);
      return false;
    }
  });

  ipcMain.handle('get-favorite-artists-backup', () => {
    try {
      const userBackup = path.join(app.getPath('userData'), 'favorite_artists_autobackup.json');
      if (fs.existsSync(userBackup)) {
        return JSON.parse(fs.readFileSync(userBackup, 'utf-8'));
      }
    } catch (e) {
      console.warn('Failed to read favorite artists backup:', e);
    }
    return [];
  });

  ipcMain.handle('save-favorite-artists-backup', async (_, artists) => {
    if (!Array.isArray(artists)) return false;
    try {
      const userBackup = path.join(app.getPath('userData'), 'favorite_artists_autobackup.json');
      const tmpPath = userBackup + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(artists, null, 2), 'utf8');
      fs.renameSync(tmpPath, userBackup);
      return true;
    } catch (e) {
      console.warn('Failed to save favorite artists backup:', e);
      return false;
    }
  });

  ipcMain.handle('get-playlists-backup', () => {
    try {
      const userBackup = path.join(app.getPath('userData'), 'playlists_autobackup.json');
      if (fs.existsSync(userBackup)) {
        return JSON.parse(fs.readFileSync(userBackup, 'utf-8'));
      }
      const rootBackup = path.join(__dirname, 'playlists_backup.json');
      if (fs.existsSync(rootBackup)) {
        return JSON.parse(fs.readFileSync(rootBackup, 'utf-8'));
      }
    } catch (e) {
      console.warn('Failed to read playlists backup:', e);
    }
    return [];
  });

  ipcMain.handle('save-playlists-backup', async (_, playlists) => {
    if (!Array.isArray(playlists)) return false;
    try {
      const userDataDir = app.getPath('userData');
      const backupPath = path.join(userDataDir, 'playlists_autobackup.json');
      const tmpPath = backupPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(playlists, null, 2), 'utf8');
      fs.renameSync(tmpPath, backupPath);

      const rootBackup = path.join(__dirname, 'playlists_backup.json');
      try {
        fs.writeFileSync(rootBackup + '.tmp', JSON.stringify(playlists, null, 2), 'utf8');
        fs.renameSync(rootBackup + '.tmp', rootBackup);
      } catch (e) {}
      return true;
    } catch (err) {
      console.warn('[BACKUP] Failed to save playlists:', err.message);
      return false;
    }
  });

  // Window Controls
  ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('window-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window-close', () => mainWindow && mainWindow.close());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  discordRpc.destroy();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  discordRpc.destroy();
});
