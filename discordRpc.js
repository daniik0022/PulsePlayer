const { Client } = require('@xhayper/discord-rpc');
const fs = require('fs');
const path = require('path');

// Public verified SoundCloud Discord Application ID ("SoundCloud")
// Activity displays as: "Listening to SoundCloud" / "Слушает SoundCloud"
const DEFAULT_CLIENT_ID = '1339181692233056356';
const SC_LOGO_FALLBACK = 'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-a62dfc8f.png';

class DiscordRpcManager {
  constructor() {
    this.clientId = this.loadConfigClientId() || DEFAULT_CLIENT_ID;
    this.client = null;
    this.isConnected = false;
    this.enabled = true;
    this.lastState = null;
    this.reconnectTimer = null;
  }

  loadConfigClientId() {
    try {
      const cfgPath = path.join(__dirname, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg.discordClientId) return String(cfg.discordClientId);
      }
    } catch (e) {}
    return null;
  }

  async init() {
    if (!this.enabled) return;
    this.connect();
  }

  connect() {
    if (this.client || !this.enabled) return;

    try {
      this.client = new Client({ clientId: this.clientId });

      this.client.on('ready', () => {
        this.isConnected = true;
        console.log(`[Discord RPC] Connected to ${this.client.application?.name || 'SoundCloud'} as ${this.client.user?.username || 'user'}`);
        if (this.lastState) {
          this.updateActivity(this.lastState);
        }
      });

      this.client.on('disconnected', () => {
        this.isConnected = false;
        this.client = null;
        this.scheduleReconnect();
      });

      this.client.login().catch(() => {
        this.isConnected = false;
        this.client = null;
        this.scheduleReconnect();
      });
    } catch (e) {
      this.isConnected = false;
      this.client = null;
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.enabled) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled && !this.isConnected) {
        this.connect();
      }
    }, 15000);
  }

  async updateActivity(state) {
    this.lastState = state;
    if (!this.enabled) return;

    if (!this.isConnected || !this.client || !this.client.user) {
      this.connect();
      return;
    }

    try {
      if (!state || !state.track) {
        await this.client.user.clearActivity();
        return;
      }

      const { track, isPlaying, currentTime = 0, duration = 0 } = state;
      const title = String(track.title || 'Unknown').slice(0, 120);
      const artist = String(track.artist || 'Unknown Artist').slice(0, 120);

      const artwork = (track.artworkUrl && track.artworkUrl.startsWith('http')) 
        ? track.artworkUrl 
        : ((track.remoteArtworkUrl && track.remoteArtworkUrl.startsWith('http'))
          ? track.remoteArtworkUrl
          : SC_LOGO_FALLBACK);

      const isLocal = track.source === 'local';
      const smallText = isLocal
        ? (isPlaying ? 'Локальный файл' : 'На паузе')
        : (isPlaying ? 'Воспроизведение' : 'На паузе');

      const activity = {
        type: 2, // 2 = LISTENING ("Слушает SoundCloud")
        details: title,
        state: isPlaying ? artist : `Paused • ${artist}`,
        largeImageKey: artwork,
        smallImageKey: SC_LOGO_FALLBACK,
        smallImageText: smallText,
        instance: false
      };

      if (isPlaying && duration > 0) {
        const now = Date.now();
        const startMs = now - Math.floor(currentTime * 1000);
        const endMs = startMs + Math.floor(duration * 1000);
        activity.startTimestamp = Math.floor(startMs / 1000);
        activity.endTimestamp = Math.floor(endMs / 1000);
      }

      if (track.permalinkUrl && track.permalinkUrl.startsWith('http')) {
        activity.buttons = [
          {
            label: track.source === 'youtube' ? 'Слушать на YouTube' : 'Слушать на SoundCloud',
            url: track.permalinkUrl
          }
        ];
      }

      await this.client.user.setActivity(activity);
    } catch (err) {
      console.warn('[Discord RPC] setActivity warning:', err.message);
    }
  }

  async clearActivity() {
    this.lastState = null;
    if (this.isConnected && this.client && this.client.user) {
      try {
        await this.client.user.clearActivity();
      } catch (e) {}
    }
  }

  setEnabled(enable) {
    this.enabled = !!enable;
    if (!this.enabled) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.client) {
        try {
          if (this.client.user) this.client.user.clearActivity().catch(() => {});
          this.client.destroy();
        } catch (e) {}
        this.client = null;
      }
      this.isConnected = false;
    } else {
      this.connect();
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      connected: this.isConnected,
      appName: this.client?.application?.name || 'SoundCloud',
      username: this.client?.user?.username || null
    };
  }

  destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        if (this.client.user) this.client.user.clearActivity().catch(() => {});
        this.client.destroy();
      } catch (e) {}
      this.client = null;
    }
    this.isConnected = false;
  }
}

module.exports = new DiscordRpcManager();
