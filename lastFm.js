const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

try {
  require('dotenv').config();
} catch (e) {}

const API_KEY = process.env.LASTFM_API_KEY || '9dd76c110427dd589152389ba8768c8d';
const SHARED_SECRET = process.env.LASTFM_SHARED_SECRET || 'bbd55aaa7e35834f3fbc3aa29ec9039a';
const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

function cleanMetadata(str) {
  if (!str) return '';
  return str
    .replace(/\s*[\(\[](?:official\s*video|music\s*video|official\s*audio|visualizer|lyric\s*video|lyrics|audio|hd|4k|prod\.[^\)\]]+|remix)[\)\]]/gi, '')
    .replace(/\s*[\(\[]?(?:prod\.|feat\.|ft\.)\s+[^\)\]]+[\)\]]?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function generateApiSig(params, secret) {
  const sortedKeys = Object.keys(params)
    .filter(k => k !== 'format' && k !== 'callback' && k !== 'api_sig')
    .sort();
  let sigString = '';
  for (const k of sortedKeys) {
    sigString += k + params[k];
  }
  sigString += secret;
  return crypto.createHash('md5').update(sigString, 'utf8').digest('hex');
}

function makeApiRequest(params, method = 'POST') {
  return new Promise((resolve, reject) => {
    params.api_sig = generateApiSig(params, SHARED_SECRET);
    params.format = 'json';

    const postData = new URLSearchParams(params).toString();

    if (method === 'GET') {
      const getUrl = `${API_ROOT}?${postData}`;
      https.get(getUrl, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) {
              reject(new Error(parsed.message || `Last.fm error code ${parsed.error}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error('Invalid JSON from Last.fm'));
          }
        });
      }).on('error', reject);
    } else {
      const urlObj = new URL(API_ROOT);
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'PulsePlayer/1.0'
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) {
              reject(new Error(parsed.message || `Last.fm error code ${parsed.error}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error('Invalid JSON from Last.fm'));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    }
  });
}

class LastFmManager {
  constructor() {
    this.sessionFile = path.join(app.getPath('userData'), 'lastfm_session.json');
    this.sessionKey = null;
    this.username = null;
    this.enabled = true;
    this.pendingToken = null;
    this.isAuthenticating = false;
    this.pollTimer = null;
    this.loadSession();
  }

  loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const raw = fs.readFileSync(this.sessionFile, 'utf8');
        const data = JSON.parse(raw);
        this.sessionKey = data.sessionKey || null;
        this.username = data.username || null;
        this.enabled = typeof data.enabled === 'boolean' ? data.enabled : true;
      }
    } catch (e) {
      this.sessionKey = null;
      this.username = null;
    }
  }

  saveSession() {
    try {
      const data = {
        sessionKey: this.sessionKey,
        username: this.username,
        enabled: this.enabled
      };
      fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
  }

  getStatus() {
    return {
      connected: Boolean(this.sessionKey),
      enabled: Boolean(this.enabled),
      username: this.username || null
    };
  }

  toggle(enabled) {
    this.enabled = Boolean(enabled);
    this.saveSession();
    return this.getStatus();
  }

  async startAuth() {
    try {
      const res = await makeApiRequest({
        method: 'auth.getToken',
        api_key: API_KEY
      }, 'GET');

      if (!res.token) throw new Error('Token not received from Last.fm');
      this.pendingToken = res.token;

      const authUrl = `https://www.last.fm/api/auth/?api_key=${API_KEY}&token=${this.pendingToken}`;
      try {
        const parsed = new URL(authUrl);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          shell.openExternal(authUrl);
        }
      } catch (e) {}

      return { success: true, token: this.pendingToken, authUrl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async completeAuth(token) {
    const t = token || this.pendingToken;
    if (!t) return { success: false, error: 'No token to verify' };

    try {
      const res = await makeApiRequest({
        method: 'auth.getSession',
        api_key: API_KEY,
        token: t
      }, 'GET');

      if (res.session && res.session.key) {
        this.sessionKey = res.session.key;
        this.username = res.session.name;
        this.enabled = true;
        this.pendingToken = null;
        this.saveSession();
        return { success: true, username: this.username };
      } else {
        return { success: false, error: 'Session not granted' };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  disconnect() {
    this.sessionKey = null;
    this.username = null;
    this.pendingToken = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isAuthenticating = false;
    try {
      if (fs.existsSync(this.sessionFile)) {
        fs.unlinkSync(this.sessionFile);
      }
    } catch (e) {}
    return this.getStatus();
  }

  async ensureAuth() {
    if (this.sessionKey) return true;
    if (this.isAuthenticating) return false;
    this.isAuthenticating = true;

    const res = await this.startAuth();
    if (!res || !res.success) {
      this.isAuthenticating = false;
      return false;
    }

    let attempts = 0;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      attempts++;
      if (this.sessionKey || attempts > 50) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.isAuthenticating = false;
        return;
      }
      try {
        const complete = await this.completeAuth(this.pendingToken);
        if (complete && complete.success) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
          this.isAuthenticating = false;
          console.log(`[Last.fm] Successfully authenticated as @${this.username}`);
        }
      } catch (e) {}
    }, 3000);

    return false;
  }

  async updateNowPlaying(track) {
    if (!this.enabled || !track) return;
    if (!this.sessionKey) {
      this.ensureAuth();
      return;
    }

    let artist = track.artist || '';
    let title = track.title || '';
    if (title.includes(' - ') && !artist) {
      const parts = title.split(' - ');
      artist = parts[0];
      title = parts.slice(1).join(' ');
    }

    artist = cleanMetadata(artist) || artist || 'Unknown Artist';
    title = cleanMetadata(title) || title || 'Unknown Track';

    try {
      await makeApiRequest({
        method: 'track.updateNowPlaying',
        api_key: API_KEY,
        sk: this.sessionKey,
        artist: artist,
        track: title
      }, 'POST');
    } catch (e) {
      console.warn('[Last.fm NowPlaying Error]:', e.message);
    }
  }

  async scrobble(track, timestamp) {
    if (!this.enabled || !track) return;
    if (!this.sessionKey) {
      this.ensureAuth();
      return;
    }

    let artist = track.artist || '';
    let title = track.title || '';
    if (title.includes(' - ') && !artist) {
      const parts = title.split(' - ');
      artist = parts[0];
      title = parts.slice(1).join(' ');
    }

    artist = cleanMetadata(artist) || artist || 'Unknown Artist';
    title = cleanMetadata(title) || title || 'Unknown Track';
    const ts = timestamp || Math.floor(Date.now() / 1000);

    try {
      await makeApiRequest({
        method: 'track.scrobble',
        api_key: API_KEY,
        sk: this.sessionKey,
        artist: artist,
        track: title,
        timestamp: String(ts)
      }, 'POST');
      return { success: true, artist, title };
    } catch (e) {
      console.warn('[Last.fm Scrobble Error]:', e.message);
      return { success: false, error: e.message };
    }
  }
}

module.exports = LastFmManager;
