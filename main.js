const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const discordRpc = require('./discordRpc');

let mainWindow = null;
let cachedClientId = 'qLcgHhXgeEFFaSolTB9I71LBsqncsD93'; // Fallback default
let lastClientFetchTime = 0;
let isYtDlpAvailable = false;

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

async function searchSoundCloud(query, limit = 25) {
  const cid = await getSoundCloudClientId();
  const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${cid}&limit=${limit}`;
  const raw = await fetchUrl(searchUrl, { 'Referer': 'https://soundcloud.com/' });
  const data = JSON.parse(raw);
  return (data.collection || []).map(mapTrackData);
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

async function resolveSoundCloudStream(track) {
  const cid = await getSoundCloudClientId();
  const tc = track.transcodings || [];
  if (!tc.length) {
    throw new Error('У трека отсутствуют потоки транскодинга');
  }

  const target = tc.find(t => t.format && t.format.protocol === 'progressive') || tc[0];
  const reqUrl = `${target.url}?client_id=${cid}`;
  const raw = await fetchUrl(reqUrl, { 'Referer': 'https://soundcloud.com/' });
  const json = JSON.parse(raw);

  return {
    streamUrl: json.url,
    protocol: target.format ? target.format.protocol : 'hls',
    mimeType: target.format ? target.format.mime_type : 'audio/mpeg'
  };
}

async function searchYouTube(query, limit = 10) {
  if (!isYtDlpAvailable) return [];
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', [
      `ytsearch${limit}:${query}`,
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings'
    ]);

    let stdout = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        return resolve([]);
      }
      try {
        const parsed = JSON.parse(stdout);
        const results = (parsed.entries || []).map(e => ({
          id: String(e.id),
          source: 'youtube',
          title: e.title || 'Untitled',
          artist: e.uploader || e.channel || 'YouTube',
          artistId: null,
          artistAvatar: '',
          durationMs: (e.duration || 0) * 1000,
          artworkUrl: (e.thumbnails && e.thumbnails.length) ? e.thumbnails[e.thumbnails.length - 1].url : '',
          permalinkUrl: e.url || `https://www.youtube.com/watch?v=${e.id}`,
          playbackCount: e.view_count || 0,
          likesCount: 0,
          transcodings: []
        }));
        resolve(results);
      } catch (err) {
        resolve([]);
      }
    });
    proc.on('error', () => resolve([]));
  });
}

async function resolveYouTubeStream(track) {
  if (!isYtDlpAvailable) {
    throw new Error('yt-dlp не установлен в системе (добавьте yt-dlp в PATH)');
  }
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '-g',
      track.permalinkUrl
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
  const dir = path.join(os.homedir(), 'Downloads', 'SC-Player');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').substring(0, 100);
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

  if (track.source === 'soundcloud') {
    try {
      const resolved = await resolveSoundCloudStream(track);
      if (resolved.protocol === 'progressive') {
        await downloadHttpFile(resolved.streamUrl, partPath);
        fs.renameSync(partPath, destPath);
        return { success: true, path: destPath };
      } else {
        await new Promise((resolve, reject) => {
          const proc = spawn('ffmpeg', [
            '-y',
            '-i', resolved.streamUrl,
            '-c', 'copy',
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
      await downloadWithYtDlp(track.permalinkUrl, destPath);
      return { success: true, path: destPath };
    }
  } else {
    await downloadWithYtDlp(track.permalinkUrl, destPath);
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
  const cleaned = sanitizeForLyrics(query);
  if (!cleaned || cleaned.length < 2) return null;
  try {
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleaned)}`;
    const raw = await fetchUrl(searchUrl, { 'User-Agent': 'PulsePlayer/1.0' });
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length > 0) {
      const match = list.find(l => l.syncedLyrics) || list.find(l => l.plainLyrics) || list[0];
      if (match.syncedLyrics || match.plainLyrics) {
        return {
          syncedLyrics: match.syncedLyrics || null,
          plainLyrics: match.plainLyrics || null,
          instrumental: !!match.instrumental,
          artist: match.artistName,
          track: match.trackName,
          source: `Поиск: ${match.artistName} - ${match.trackName}`
        };
      }
    }
  } catch (e) {}
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
  const cleanDest = destPath.replace(/\.part$/, '');
  const outTemplate = cleanDest.endsWith('.mp3') ? cleanDest.slice(0, -4) + '.%(ext)s' : cleanDest + '.%(ext)s';

  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', outTemplate,
      url
    ]);
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
        reject(new Error(`yt-dlp завершился с кодом ${code}`));
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
      webSecurity: false
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
  await checkYtDlp();
  createWindow();
  discordRpc.init();

  // IPC Handlers
  ipcMain.handle('search-tracks', async (_, { query, source }) => {
    if (source === 'youtube') return await searchYouTube(query);
    return await searchSoundCloud(query);
  });

  ipcMain.handle('get-artist-profile', async (_, artistId) => {
    return await getArtistProfile(artistId);
  });

  ipcMain.handle('get-related-tracks', async (_, trackId) => {
    return await getRelatedTracks(trackId);
  });

  ipcMain.handle('resolve-stream', async (_, track) => {
    if (track.source === 'youtube') return await resolveYouTubeStream(track);
    return await resolveSoundCloudStream(track);
  });

  ipcMain.handle('download-track', async (_, track) => {
    return await downloadTrack(track);
  });

  ipcMain.handle('get-lyrics', async (_, track) => {
    return await fetchLyrics(track);
  });

  ipcMain.handle('search-lyrics-query', async (_, query) => {
    return await searchLyricsManual(query);
  });

  ipcMain.handle('open-download-dir', () => {
    const dir = getDownloadDir();
    shell.openPath(dir);
    return dir;
  });

  // Discord RPC Handlers
  ipcMain.handle('update-discord-rpc', async (_, data) => {
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
