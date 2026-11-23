// Pulse Player - Core Renderer
(() => {
  // Safe Storage & Sanitization Helpers
  function safeParseLS(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      console.warn(`[LS] Failed parsing ${key}:`, e.message);
      return fallback;
    }
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Clean initial state wipe for distribution
  if (localStorage.getItem('pulse_clean_v1') !== 'true') {
    localStorage.removeItem('pulse_favorites');
    localStorage.removeItem('pulse_history');
    localStorage.removeItem('pulse_play_stats');
    localStorage.removeItem('pulse_last_session');
    localStorage.setItem('pulse_clean_v1', 'true');
  }

  // State
  let currentTrack = null;
  let isPlaying = false;
  let queue = [];
  let queueIndex = -1;
  let history = safeParseLS('pulse_history', []);
  let favorites = safeParseLS('pulse_favorites', []);
  let playStats = safeParseLS('pulse_play_stats', { tracks: {}, artists: {} });
  let lastSession = safeParseLS('pulse_last_session', null);
  let lastSessionSaveTime = 0;

  // Auto-restore backup if empty
  if (favorites.length === 0 && window.api?.getFavoritesBackup) {
    window.api.getFavoritesBackup().then(backup => {
      if (backup && backup.length > 0 && favorites.length === 0) {
        favorites = backup;
        localStorage.setItem('pulse_favorites', JSON.stringify(favorites));
        if (typeof updateBadgeCounts === 'function') updateBadgeCounts();
        if (typeof renderHomeView === 'function') renderHomeView();
      }
    }).catch(() => {});
  }
  let currentSource = 'soundcloud';
  let repeatMode = 'off'; // 'off' | 'all' | 'one'
  let isShuffle = false;
  let isVisualizerActive = true;
  let hlsInstance = null;
  let hlsRetryCount = 0;

  // High-Quality Shuffle Engine (Fisher-Yates Deck + History Stack)
  let shuffleDeck = [];
  let shuffleHistory = [];
  let shuffleHistoryIndex = -1;

  function fisherYatesShuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function initShuffleDeck(startingIndex = -1) {
    if (!queue.length) {
      shuffleDeck = [];
      shuffleHistory = [];
      shuffleHistoryIndex = -1;
      return;
    }
    const remaining = [];
    for (let i = 0; i < queue.length; i++) {
      if (i !== startingIndex) remaining.push(i);
    }
    shuffleDeck = fisherYatesShuffle(remaining);
    if (startingIndex >= 0) {
      shuffleHistory = [startingIndex];
      shuffleHistoryIndex = 0;
    } else {
      shuffleHistory = [];
      shuffleHistoryIndex = -1;
    }
  }

  // Navigation History Stack (Two-way Back / Forward)
  let navHistory = ['home'];
  let navHistoryIndex = 0;
  let currentArtistData = null;

  // DOM Elements
  const audio = document.getElementById('audioElement');
  const searchInput = document.getElementById('searchInput');
  const searchClearBtn = document.getElementById('searchClearBtn');
  const btnBack = document.getElementById('btnBack');
  const btnForward = document.getElementById('btnForward');

  // Views
  const viewHome = document.getElementById('viewHome');
  const viewSearch = document.getElementById('viewSearch');
  const viewArtist = document.getElementById('viewArtist');
  const viewLyrics = document.getElementById('viewLyrics');
  const viewStats = document.getElementById('viewStats');
  const statsTotalPlays = document.getElementById('statsTotalPlays');
  const statsUniqueTracks = document.getElementById('statsUniqueTracks');
  const statsTopArtist = document.getElementById('statsTopArtist');
  const statsTopTracksList = document.getElementById('statsTopTracksList');
  const statsTopArtistsList = document.getElementById('statsTopArtistsList');

  // Home elements
  const btnPlayFavsHome = document.getElementById('btnPlayFavsHome');
  const homeCardsGrid = document.getElementById('homeCardsGrid');
  const homeFavCount = document.getElementById('homeFavCount');

  // Search elements
  const viewTitle = document.getElementById('viewTitle');
  const resultsCount = document.getElementById('resultsCount');
  const tracksList = document.getElementById('tracksList');
  const searchInitialState = document.getElementById('searchInitialState');
  const searchLoader = document.getElementById('searchLoader');
  const searchLoaderText = document.getElementById('searchLoaderText');

  // Artist elements
  const artistBanner = document.getElementById('artistBanner');
  const artistAvatarImg = document.getElementById('artistAvatarImg');
  const artistAvatarFallback = document.getElementById('artistAvatarFallback');
  const artistName = document.getElementById('artistName');
  const artistRealName = document.getElementById('artistRealName');
  const artistVerifiedBadge = document.getElementById('artistVerifiedBadge');
  const artistFollowers = document.getElementById('artistFollowers');
  const artistTrackCount = document.getElementById('artistTrackCount');
  const artistAlbumCount = document.getElementById('artistAlbumCount');
  const artistLocation = document.getElementById('artistLocation');
  const artistLocationDot = document.getElementById('artistLocationDot');
  const btnArtistPlayAll = document.getElementById('btnArtistPlayAll');
  const btnArtistOpenWeb = document.getElementById('btnArtistOpenWeb');

  // Artist subtabs
  const tabBadgeTracks = document.getElementById('tabBadgeTracks');
  const tabBadgeAlbums = document.getElementById('tabBadgeAlbums');
  const tabBadgePlaylists = document.getElementById('tabBadgePlaylists');
  const artistPaneTracks = document.getElementById('artistPaneTracks');
  const artistPaneAlbums = document.getElementById('artistPaneAlbums');
  const artistPanePlaylists = document.getElementById('artistPanePlaylists');
  const artistPaneBio = document.getElementById('artistPaneBio');
  const artistTracksList = document.getElementById('artistTracksList');
  const artistAlbumsGrid = document.getElementById('artistAlbumsGrid');
  const artistPlaylistsGrid = document.getElementById('artistPlaylistsGrid');
  const artistBioText = document.getElementById('artistBioText');
  const bioLikes = document.getElementById('bioLikes');
  const bioPlaylists = document.getElementById('bioPlaylists');
  const bioUserId = document.getElementById('bioUserId');

  // Player Elements
  const playerArtworkWrapper = document.getElementById('playerArtworkWrapper');
  const playerArtwork = document.getElementById('playerArtwork');
  const playerArtworkFallback = document.getElementById('playerArtworkFallback');
  const playerTitle = document.getElementById('playerTitle');
  const playerArtist = document.getElementById('playerArtist');
  const hudAudioRate = document.getElementById('hudAudioRate');
  const playerMiniEq = document.getElementById('playerMiniEq');
  const playerLikeBtn = document.getElementById('playerLikeBtn');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const iconPlay = document.getElementById('iconPlay');
  const iconPause = document.getElementById('iconPause');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnShuffle = document.getElementById('btnShuffle');
  const btnRepeat = document.getElementById('btnRepeat');
  const repeatBadge = document.getElementById('repeatBadge');
  const seekSlider = document.getElementById('seekSlider');
  const seekFill = document.getElementById('seekFill');
  const currentTimeEl = document.getElementById('currentTime');
  const totalDurationEl = document.getElementById('totalDuration');

  let trackStatsRecorded = false;
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeFill = document.getElementById('volumeFill');
  const btnMute = document.getElementById('btnMute');
  const iconVolHigh = document.getElementById('iconVolHigh');
  const iconVolMuted = document.getElementById('iconVolMuted');
  const btnVisualizer = document.getElementById('btnVisualizer');
  const btnDiscord = document.getElementById('btnDiscord');
  const btnLyrics = document.getElementById('btnLyrics');
  const focusContainer = document.getElementById('focusContainer');
  const focusAmbientBackdrop = document.getElementById('focusAmbientBackdrop');
  const btnCloseFocusView = document.getElementById('btnCloseFocusView');
  const focusArtCard = document.getElementById('focusArtCard');
  const focusArtGlow = document.getElementById('focusArtGlow');
  const focusArtworkImg = document.getElementById('focusArtworkImg');
  const focusArtFallback = document.getElementById('focusArtFallback');
  const focusTrackTitle = document.getElementById('focusTrackTitle');
  const focusTrackArtist = document.getElementById('focusTrackArtist');
  const focusLikeBtn = document.getElementById('focusLikeBtn');
  const focusTagSource = document.getElementById('focusTagSource');
  const focusTagRate = document.getElementById('focusTagRate');
  const focusTagDuration = document.getElementById('focusTagDuration');
  const lyricsOverlay = document.getElementById('lyricsOverlay');
  const lyricsBackdrop = document.getElementById('lyricsBackdrop');
  const lyricsTrackTitle = document.getElementById('lyricsTrackTitle') || document.getElementById('focusTrackTitle');
  const lyricsTrackArtist = document.getElementById('lyricsTrackArtist') || document.getElementById('focusTrackArtist');
  const lyricsSourceBadge = document.getElementById('lyricsSourceBadge');
  const btnCloseLyrics = document.getElementById('btnCloseLyrics');
  const lyricsManualInput = document.getElementById('lyricsManualInput');
  const btnSearchLyricsManual = document.getElementById('btnSearchLyricsManual');
  const btnSaveLyricsQuery = document.getElementById('btnSaveLyricsQuery');
  const btnSaveLyricsQueryText = document.getElementById('btnSaveLyricsQueryText');
  const lyricsScrollContainer = document.getElementById('lyricsScrollContainer');
  const lyricsLoader = document.getElementById('lyricsLoader');
  const lyricsEmpty = document.getElementById('lyricsEmpty');
  const lyricsContent = document.getElementById('lyricsContent');
  const btnDownloadCurrent = document.getElementById('btnDownloadCurrent');
  const btnOpenDownloads = document.getElementById('btnOpenDownloads');
  const favCountEl = document.getElementById('favCount');
  const localCountEl = document.getElementById('localCount');
  const queueCountEl = document.getElementById('queueCount');
  const btnImportHeader = document.getElementById('btnImportHeader');
  const btnImportHome = document.getElementById('btnImportHome');
  const dragDropOverlay = document.getElementById('dragDropOverlay');
  let localTracks = safeParseLS('pulse_local_tracks', []);

  if (window.api?.getLocalTracksBackup) {
    window.api.getLocalTracksBackup().then(backup => {
      if (Array.isArray(backup) && backup.length > 0) {
        if (!localTracks.length || backup.length > localTracks.length) {
          localTracks = backup;
          localStorage.setItem('pulse_local_tracks', JSON.stringify(localTracks));
          updateBadgeCounts();
        }
      }
    }).catch(() => {});
  }
  const toast = document.getElementById('toast');
  const canvas = document.getElementById('visualizerCanvas');
  const canvasCtx = canvas.getContext('2d');

  // Wave Engine State & DOM
  const btnNavWave = document.getElementById('btnNavWave');
  const waveLiveBadge = document.getElementById('waveLiveBadge');
  let isWaveMode = false;
  let wavePool = [];
  let waveRecentTracks = [];
  let waveSeedTrack = null;
  let isWaveFetching = false;
  const WAVE_MIN_ARTIST_DISTANCE = 8;

  // Discord RPC State
  let isDiscordRpcEnabled = localStorage.getItem('pulse_discord_rpc') !== 'false';
  let lastDiscordSyncTime = 0;

  // Lyrics State & Persistent Track Search Query Binding
  let isLyricsOpen = false;
  let parsedLyrics = [];
  let isSyncedLyrics = false;
  let currentLyricsTrackId = null;
  let currentActiveLyricIndex = -1;
  let savedLyricsQueries = safeParseLS('pulse_lyrics_queries', {});
  let lyricsScrollAnimId = null;

  function smoothScrollLyricsTo(container, targetY, duration = 380) {
    if (lyricsScrollAnimId) {
      cancelAnimationFrame(lyricsScrollAnimId);
      lyricsScrollAnimId = null;
    }
    const startY = container.scrollTop;
    const diff = targetY - startY;
    if (Math.abs(diff) < 1) return;

    const startTime = performance.now();
    function easeOutCubic(t) {
      return 1 - Math.pow(1 - t, 3);
    }

    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(progress);
      container.scrollTop = startY + diff * eased;
      if (progress < 1) {
        lyricsScrollAnimId = requestAnimationFrame(step);
      } else {
        lyricsScrollAnimId = null;
      }
    }
    lyricsScrollAnimId = requestAnimationFrame(step);
  }

  function getSavedLyricsQuery(track) {
    if (!track) return null;
    const idKey = String(track.id);
    const normKey = `${(track.artist || '').toLowerCase().trim()}:::${(track.title || '').toLowerCase().trim()}`;
    return savedLyricsQueries[idKey] || savedLyricsQueries[normKey] || null;
  }

  function setSavedLyricsQuery(track, query) {
    if (!track) return;
    const idKey = String(track.id);
    const normKey = `${(track.artist || '').toLowerCase().trim()}:::${(track.title || '').toLowerCase().trim()}`;
    if (query) {
      savedLyricsQueries[idKey] = query;
      savedLyricsQueries[normKey] = query;
    } else {
      delete savedLyricsQueries[idKey];
      delete savedLyricsQueries[normKey];
    }
    localStorage.setItem('pulse_lyrics_queries', JSON.stringify(savedLyricsQueries));
  }

  function parseLRC(text) {
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2}(?:\.\d+)?)\](.*)/;

    for (const line of lines) {
      const match = line.match(timeRegex);
      if (match) {
        const min = parseFloat(match[1]);
        const sec = parseFloat(match[2]);
        const time = min * 60 + sec;
        const lineText = match[3].trim();
        if (lineText) {
          result.push({ time, text: lineText });
        }
      }
    }
    return result.sort((a, b) => a.time - b.time);
  }

  async function loadLyrics(forceQuery = null) {
    if (!currentTrack) {
      if (lyricsTrackTitle) lyricsTrackTitle.textContent = 'Нет воспроизведения';
      if (lyricsTrackArtist) lyricsTrackArtist.textContent = '—';
      if (focusTrackTitle) focusTrackTitle.textContent = 'Нет воспроизведения';
      if (focusTrackArtist) focusTrackArtist.textContent = '—';
      if (lyricsManualInput) lyricsManualInput.value = '';
      lyricsContent.innerHTML = '';
      lyricsLoader.style.display = 'none';
      lyricsEmpty.style.display = 'flex';
      return;
    }

    if (lyricsTrackTitle) lyricsTrackTitle.textContent = currentTrack.title;
    if (lyricsTrackArtist) lyricsTrackArtist.textContent = currentTrack.artist;
    if (focusTrackTitle) focusTrackTitle.textContent = currentTrack.title;
    if (focusTrackArtist) focusTrackArtist.textContent = currentTrack.artist;

    if (lyricsBackdrop) {
      if (currentTrack.artworkUrl) {
        lyricsBackdrop.style.backgroundImage = `url("${currentTrack.artworkUrl}")`;
      } else {
        lyricsBackdrop.style.backgroundImage = 'none';
      }
    }

    const savedQuery = getSavedLyricsQuery(currentTrack);
    const effectiveQuery = forceQuery !== null ? forceQuery : (savedQuery || null);

    if (lyricsManualInput) {
      if (savedQuery) {
        lyricsManualInput.value = savedQuery;
      } else if (forceQuery !== null) {
        lyricsManualInput.value = forceQuery;
      } else {
        const art = (currentTrack.artist || '').trim();
        const tit = (currentTrack.title || '').trim();
        lyricsManualInput.value = (art && !tit.toLowerCase().includes(art.toLowerCase())) ? `${art} ${tit}` : tit;
      }
    }

    if (btnSaveLyricsQuery) {
      if (savedQuery) {
        btnSaveLyricsQuery.classList.add('active');
        if (btnSaveLyricsQueryText) btnSaveLyricsQueryText.textContent = 'Запомнено';
        btnSaveLyricsQuery.title = `Название сохранено за треком (${savedQuery}). Клик — сбросить`;
      } else {
        btnSaveLyricsQuery.classList.remove('active');
        if (btnSaveLyricsQueryText) btnSaveLyricsQueryText.textContent = 'Запомнить';
        btnSaveLyricsQuery.title = 'Запомнить это название для текущей песни';
      }
    }

    if (!forceQuery && currentLyricsTrackId === currentTrack.id && parsedLyrics.length > 0) {
      return;
    }

    currentLyricsTrackId = currentTrack.id;
    lyricsContent.innerHTML = '';
    lyricsEmpty.style.display = 'none';
    lyricsLoader.style.display = 'flex';
    parsedLyrics = [];
    isSyncedLyrics = false;
    currentActiveLyricIndex = -1;
    if (lyricsScrollAnimId) {
      cancelAnimationFrame(lyricsScrollAnimId);
      lyricsScrollAnimId = null;
    }

    try {
      let data = null;
      if (effectiveQuery) {
        data = await window.api.searchLyricsQuery(effectiveQuery);
      } else {
        data = await window.api.getLyrics(currentTrack);
      }

      lyricsLoader.style.display = 'none';

      if (!data || (!data.syncedLyrics && !data.plainLyrics && !data.instrumental)) {
        lyricsEmpty.style.display = 'flex';
        lyricsEmpty.innerHTML = `
          <div class="empty-icon">📝</div>
          <h3>Текст не найден</h3>
          <p>Для этого трека пока нет текста в базе LRCLIB. Попробуй уточнить название в поиске выше (например: «Артист Название»).</p>
        `;
        if (lyricsSourceBadge) lyricsSourceBadge.style.display = 'none';
        return;
      }

      if (data.instrumental) {
        lyricsEmpty.style.display = 'flex';
        lyricsEmpty.innerHTML = `
          <div class="empty-icon">🎹</div>
          <h3>Инструментальный трек</h3>
          <p>В этом треке нет вокала / текста (Instrumental).</p>
        `;
        if (lyricsSourceBadge) {
          lyricsSourceBadge.textContent = 'INSTRUMENTAL';
          lyricsSourceBadge.style.display = 'inline-block';
        }
        return;
      }

      if (data.source && lyricsSourceBadge) {
        lyricsSourceBadge.textContent = data.source;
        lyricsSourceBadge.style.display = 'inline-block';
      } else if (lyricsSourceBadge) {
        lyricsSourceBadge.style.display = 'none';
      }

      if (data.syncedLyrics) {
        isSyncedLyrics = true;
        parsedLyrics = parseLRC(data.syncedLyrics);

        if (!parsedLyrics.length) {
          if (data.plainLyrics) {
            renderPlainLyrics(data.plainLyrics);
          } else {
            lyricsEmpty.style.display = 'flex';
          }
          return;
        }

        parsedLyrics.forEach((item, idx) => {
          const lineEl = document.createElement('div');
          lineEl.className = 'lyric-line';
          lineEl.dataset.idx = idx;
          lineEl.textContent = item.text;

          lineEl.addEventListener('click', () => {
            audio.currentTime = item.time;
            if (audio.paused) audio.play();
          });

          lyricsContent.appendChild(lineEl);
        });
      } else if (data.plainLyrics) {
        renderPlainLyrics(data.plainLyrics);
      } else {
        lyricsEmpty.style.display = 'flex';
      }
    } catch (err) {
      lyricsLoader.style.display = 'none';
      lyricsEmpty.style.display = 'flex';
      console.error('Failed to load lyrics:', err);
    }
  }

  function renderPlainLyrics(text) {
    isSyncedLyrics = false;
    lyricsContent.innerHTML = '';
    const plainBox = document.createElement('div');
    plainBox.className = 'plain-lyrics-container';
    
    const lines = text.split(/\r?\n/);
    lines.forEach(l => {
      const p = document.createElement('div');
      p.className = l.trim() ? 'plain-lyric-row' : 'plain-lyric-gap';
      p.textContent = l.trim() || '';
      plainBox.appendChild(p);
    });
    lyricsContent.appendChild(plainBox);
  }

  if (btnSaveLyricsQuery) {
    btnSaveLyricsQuery.addEventListener('click', () => {
      if (!currentTrack) return;
      const currentSaved = getSavedLyricsQuery(currentTrack);
      const inputVal = lyricsManualInput.value.trim();

      if (currentSaved) {
        setSavedLyricsQuery(currentTrack, null);
        btnSaveLyricsQuery.classList.remove('active');
        if (btnSaveLyricsQueryText) btnSaveLyricsQueryText.textContent = 'Запомнить';
        btnSaveLyricsQuery.title = 'Запомнить это название для текущей песни';
        lyricsManualInput.value = `${currentTrack.artist || ''} ${currentTrack.title || ''}`.trim();
        showToast('Поисковое название сброшено к оригинальному');
        loadLyrics();
      } else {
        if (!inputVal) {
          showToast('Введи название трека');
          return;
        }
        setSavedLyricsQuery(currentTrack, inputVal);
        btnSaveLyricsQuery.classList.add('active');
        if (btnSaveLyricsQueryText) btnSaveLyricsQueryText.textContent = 'Запомнено';
        btnSaveLyricsQuery.title = `Название сохранено за треком (${inputVal}). Клик — сбросить`;
        showToast(`Название "${inputVal}" закреплено за треком`);
        loadLyrics(inputVal);
      }
    });
  }

  if (lyricsManualInput) {
    lyricsManualInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = lyricsManualInput.value.trim() || `${currentTrack?.artist || ''} ${currentTrack?.title || ''}`.trim();
        if (q && currentTrack) {
          setSavedLyricsQuery(currentTrack, q);
          if (btnSaveLyricsQuery) {
            btnSaveLyricsQuery.classList.add('active');
            if (btnSaveLyricsQueryText) btnSaveLyricsQueryText.textContent = 'Запомнено';
            btnSaveLyricsQuery.title = `Название сохранено за треком (${q}). Клик — сбросить`;
          }
          showToast(`Ищем и запоминаем: "${q}"`);
          loadLyrics(q);
        }
      }
    });
  }

  if (btnSearchLyricsManual) {
    btnSearchLyricsManual.addEventListener('click', () => {
      const q = lyricsManualInput.value.trim() || `${currentTrack?.artist || ''} ${currentTrack?.title || ''}`.trim();
      if (q && currentTrack) {
        setSavedLyricsQuery(currentTrack, q);
        if (btnSaveLyricsQuery) {
          btnSaveLyricsQuery.classList.add('active');
          if (btnSaveLyricsQueryText) btnSaveLyricsQueryText.textContent = 'Запомнено';
          btnSaveLyricsQuery.title = `Название сохранено за треком (${q}). Клик — сбросить`;
        }
        showToast(`Ищем и запоминаем: "${q}"`);
        loadLyrics(q);
      }
    });
  }

  if (lyricsScrollContainer) {
    lyricsScrollContainer.addEventListener('wheel', () => {
      if (lyricsScrollAnimId) {
        cancelAnimationFrame(lyricsScrollAnimId);
        lyricsScrollAnimId = null;
      }
    }, { passive: true });
  }

  function toggleLyrics() {
    if (navHistory[navHistoryIndex] === 'lyrics') {
      navigateBack();
    } else {
      switchView('lyrics');
    }
  }

  // Focus View Mode Switcher: Cover / Split (50/50) / Lyrics
  let focusMode = localStorage.getItem('pulse_focus_mode') || 'split';
  function applyFocusMode(mode) {
    focusMode = mode;
    localStorage.setItem('pulse_focus_mode', mode);
    if (focusContainer) focusContainer.dataset.mode = mode;
    document.querySelectorAll('.focus-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }
  applyFocusMode(focusMode);

  document.querySelectorAll('.focus-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode) applyFocusMode(mode);
    });
  });

  if (btnLyrics) btnLyrics.addEventListener('click', toggleLyrics);
  if (btnCloseFocusView) {
    btnCloseFocusView.addEventListener('click', navigateBack);
  }
  if (btnCloseLyrics) {
    btnCloseLyrics.addEventListener('click', navigateBack);
  }
  if (focusLikeBtn) {
    focusLikeBtn.addEventListener('click', () => {
      if (currentTrack) toggleFavorite(currentTrack);
    });
  }
  if (focusTrackArtist) {
    focusTrackArtist.style.cursor = 'pointer';
    focusTrackArtist.addEventListener('click', () => {
      if (!currentTrack) return;
      if (currentTrack.source === 'local') {
        showToast(`Исполнитель: ${currentTrack.artist}`);
      } else if (currentTrack.artistId) {
        openArtistProfile(currentTrack.artistId);
      } else if (currentTrack.artist) {
        performSearch(currentTrack.artist);
      }
    });
  }

  // Web Audio Context for Spectrum Visualizer
  let audioCtx = null;
  let analyser = null;
  let dataArray = null;

  function initWebAudio() {
    if (audioCtx) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      const source = audioCtx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      renderVisualizer();
    } catch (e) {
      console.warn('Web Audio init skipped:', e);
    }
  }

  function renderVisualizer() {
    requestAnimationFrame(renderVisualizer);
    if (!isVisualizerActive || !analyser || !isPlaying) {
      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    analyser.getByteFrequencyData(dataArray);
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    const count = Math.min(analyser.frequencyBinCount, 64);
    const barWidth = canvas.width / count;
    let x = 0;

    for (let i = 0; i < count; i++) {
      const val = dataArray[i] / 255;
      const barHeight = val * canvas.height * 0.94;
      const by = canvas.height - barHeight;
      const bw = Math.max(2, barWidth - 3);

      // Cyberpunk dual-tone laser gradient (Cyan #00f0ff -> Neon Magenta #ff0055)
      const grad = canvasCtx.createLinearGradient(0, canvas.height, 0, by);
      grad.addColorStop(0, 'rgba(0, 240, 255, 0.04)');
      grad.addColorStop(0.35, 'rgba(0, 240, 255, 0.45)');
      grad.addColorStop(0.8, 'rgba(255, 0, 85, 0.75)');
      grad.addColorStop(1, 'rgba(255, 0, 128, 0.98)');

      canvasCtx.fillStyle = grad;
      canvasCtx.beginPath();
      if (canvasCtx.roundRect) {
        canvasCtx.roundRect(x, by, bw, barHeight, [2, 2, 0, 0]);
      } else {
        canvasCtx.rect(x, by, bw, barHeight);
      }
      canvasCtx.fill();

      // Cyber apex spark indicator
      if (val > 0.35) {
        canvasCtx.fillStyle = val > 0.8 ? '#00f0ff' : 'rgba(255, 255, 255, 0.9)';
        canvasCtx.shadowColor = '#00f0ff';
        canvasCtx.shadowBlur = val > 0.8 ? 8 : 3;
        canvasCtx.fillRect(x, by - 2, bw, 2);
        canvasCtx.shadowBlur = 0;
      }

      x += barWidth;
    }
  }

  function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Helpers
  function formatTime(sec) {
    if (isNaN(sec) || sec === null || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function formatMs(ms) {
    return formatTime(Math.floor((ms || 0) / 1000));
  }

  function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function updateBadgeCounts() {
    if (favCountEl) favCountEl.textContent = favorites.length;
    if (localCountEl) localCountEl.textContent = localTracks.length;
    if (queueCountEl) queueCountEl.textContent = queue.length;
  }

  function saveLocalTracks() {
    localStorage.setItem('pulse_local_tracks', JSON.stringify(localTracks));
    if (window.api && window.api.saveLocalTracksBackup) {
      window.api.saveLocalTracksBackup(localTracks).catch(() => {});
    }
    updateBadgeCounts();
  }

  async function importLocalTracks() {
    try {
      if (!window.api || !window.api.openLocalFiles) return;
      const imported = await window.api.openLocalFiles();
      if (!imported || !imported.length) return;
      addImportedTracks(imported);
    } catch (err) {
      console.error('Import error:', err);
      showToast(`Ошибка импорта: ${err.message}`);
    }
  }

  function addImportedTracks(newTracks) {
    if (!Array.isArray(newTracks) || !newTracks.length) return;
    let addedCount = 0;
    newTracks.forEach(nt => {
      const exists = localTracks.some(lt => lt.id === nt.id || (lt.filePath && lt.filePath.toLowerCase() === nt.filePath?.toLowerCase()));
      if (!exists) {
        localTracks.push(nt);
        addedCount++;
      }
    });

    if (addedCount > 0) {
      saveLocalTracks();
      showToast(`Импортировано треков: ${addedCount}`);
      const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
      if (activeTab === 'local') {
        handleSidebarTab('local');
      }
    } else {
      showToast('Выбранные треки уже есть в списке');
    }
  }

  if (btnImportHeader) btnImportHeader.addEventListener('click', importLocalTracks);
  if (btnImportHome) btnImportHome.addEventListener('click', importLocalTracks);

  // Drag & Drop Audio Files onto Window
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    if (dragDropOverlay) dragDropOverlay.style.display = 'flex';
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      if (dragDropOverlay) dragDropOverlay.style.display = 'none';
    }
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    if (dragDropOverlay) dragDropOverlay.style.display = 'none';

    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;

    const paths = files.map(f => {
      if (window.api && typeof window.api.getPathForFile === 'function') {
        return window.api.getPathForFile(f);
      }
      return f.path || '';
    }).filter(Boolean);

    if (paths.length > 0 && window.api && window.api.parseLocalFilePaths) {
      try {
        const parsed = await window.api.parseLocalFilePaths(paths);
        if (parsed && parsed.length > 0) {
          addImportedTracks(parsed);
        } else {
          showToast('Не найдено поддерживаемых аудиофайлов');
        }
      } catch (err) {
        showToast(`Ошибка добавления файлов: ${err.message}`);
      }
    }
  });

  // Window Controls
  document.getElementById('btnMinimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btnMaximize').addEventListener('click', () => window.api.maximize());
  document.getElementById('btnClose').addEventListener('click', () => window.api.close());
  btnOpenDownloads.addEventListener('click', () => window.api.openDownloadDir());

  // View Navigation System (Two-way Stack)
  function updateNavButtons() {
    if (btnBack) btnBack.disabled = navHistoryIndex <= 0;
    if (btnForward) btnForward.disabled = navHistoryIndex >= navHistory.length - 1;
  }

  function navigateBack() {
    if (navHistoryIndex > 0) {
      navHistoryIndex--;
      applyView(navHistory[navHistoryIndex]);
    }
  }

  function navigateForward() {
    if (navHistoryIndex < navHistory.length - 1) {
      navHistoryIndex++;
      applyView(navHistory[navHistoryIndex]);
    }
  }

  function switchView(viewName, pushHistory = true) {
    if (pushHistory) {
      if (navHistory[navHistoryIndex] !== viewName) {
        navHistory = navHistory.slice(0, navHistoryIndex + 1);
        navHistory.push(viewName);
        navHistoryIndex = navHistory.length - 1;
      }
    }
    applyView(viewName);
  }

  function applyView(viewName) {
    updateNavButtons();

    viewHome.style.display = 'none';
    viewSearch.style.display = 'none';
    viewArtist.style.display = 'none';
    if (viewLyrics) viewLyrics.style.display = 'none';
    if (viewStats) viewStats.style.display = 'none';
    if (btnImportHeader) btnImportHeader.style.display = 'none';

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));

    if (viewName === 'home') {
      viewHome.style.display = 'flex';
      const nav = document.querySelector('.nav-item[data-tab="home"]');
      if (nav) nav.classList.add('active');
      renderHomeView();
    } else if (viewName === 'search') {
      viewSearch.style.display = 'flex';
      const nav = document.querySelector('.nav-item[data-tab="search"]');
      if (nav) nav.classList.add('active');
      viewTitle.textContent = 'Поиск треков';
      document.getElementById('sourceSelector').style.display = 'flex';
      if (!searchInput.value.trim()) {
        searchInitialState.style.display = 'flex';
        tracksList.style.display = 'none';
      }
    } else if (viewName === 'local') {
      viewSearch.style.display = 'flex';
      const nav = document.querySelector('.nav-item[data-tab="local"]');
      if (nav) nav.classList.add('active');
      viewTitle.textContent = 'Мои треки';
      document.getElementById('sourceSelector').style.display = 'none';
      if (btnImportHeader) btnImportHeader.style.display = 'inline-flex';
      searchInitialState.style.display = 'none';
      searchLoader.style.display = 'none';
      tracksList.style.display = 'flex';
      resultsCount.textContent = `${localTracks.length} треков`;
      if (!localTracks.length) {
        tracksList.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📁</div>
            <h3>Локальных треков пока нет</h3>
            <p>Импортируй любимые аудиофайлы с диска или просто перетащи их в окно плеера</p>
            <button class="btn-import-empty" id="btnImportEmpty">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              <span>Выбрать файлы</span>
            </button>
          </div>`;
        document.getElementById('btnImportEmpty')?.addEventListener('click', importLocalTracks);
      } else {
        renderTrackRows(localTracks, tracksList);
      }
    } else if (viewName === 'favorites') {
      viewSearch.style.display = 'flex';
      const nav = document.querySelector('.nav-item[data-tab="favorites"]');
      if (nav) nav.classList.add('active');
      viewTitle.textContent = 'Любимые треки';
      document.getElementById('sourceSelector').style.display = 'none';
      searchInitialState.style.display = 'none';
      searchLoader.style.display = 'none';
      tracksList.style.display = 'flex';
      resultsCount.textContent = `${favorites.length} треков`;
      if (!favorites.length) {
        tracksList.innerHTML = `<div class="empty-state"><div class="empty-icon">❤️</div><h3>Список пуст</h3><p>Добавляй треки в любимые кликом по сердечку</p></div>`;
      } else {
        renderTrackRows(favorites, tracksList);
      }
    } else if (viewName === 'lyrics') {
      const contentArea = document.querySelector('.content-area');
      if (contentArea) {
        contentArea.scrollTop = 0;
        contentArea.classList.add('lyrics-mode-active');
      }
      if (viewLyrics) viewLyrics.style.display = 'flex';
      const nav = document.querySelector('.nav-item[data-tab="lyrics"]');
      if (nav) nav.classList.add('active');
      isLyricsOpen = true;
      if (btnLyrics) btnLyrics.classList.add('active');
      if (currentTrack) updatePlayerMeta(currentTrack);
      loadLyrics();
      return;
    } else if (viewName === 'history') {
      viewSearch.style.display = 'flex';
      const nav = document.querySelector('.nav-item[data-tab="history"]');
      if (nav) nav.classList.add('active');
      viewTitle.textContent = 'История прослушиваний';
      document.getElementById('sourceSelector').style.display = 'none';
      searchInitialState.style.display = 'none';
      searchLoader.style.display = 'none';
      tracksList.style.display = 'flex';
      resultsCount.textContent = `${history.length} треков`;
      if (!history.length) {
        tracksList.innerHTML = `<div class="empty-state"><div class="empty-icon">🕒</div><h3>История чиста</h3><p>Здесь появятся треки, которые ты слушал</p></div>`;
      } else {
        renderTrackRows(history, tracksList);
      }
    } else if (viewName === 'stats') {
      if (viewStats) viewStats.style.display = 'flex';
      const nav = document.querySelector('.nav-item[data-tab="stats"]');
      if (nav) nav.classList.add('active');
      renderStatsView();
    } else if (viewName === 'artist') {
      viewArtist.style.display = 'flex';
    }

    if (viewName !== 'lyrics') {
      isLyricsOpen = false;
      const contentArea = document.querySelector('.content-area');
      if (contentArea) contentArea.classList.remove('lyrics-mode-active');
      if (btnLyrics) btnLyrics.classList.remove('active');
    }
  }

  // Navigation Items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      handleSidebarTab(tab);
    });
  });

  function handleSidebarTab(tab) {
    switchView(tab);
  }

  // Button Click Listeners
  btnBack.addEventListener('click', navigateBack);
  if (btnForward) btnForward.addEventListener('click', navigateForward);

  // Mouse Buttons 4 (Back / rear side button) & 5 (Forward / front side button)
  window.addEventListener('mouseup', (e) => {
    // e.button === 3 -> XBUTTON1 (Mouse 4: Back / rear)
    if (e.button === 3) {
      e.preventDefault();
      e.stopPropagation();
      navigateBack();
    }
    // e.button === 4 -> XBUTTON2 (Mouse 5: Forward / front)
    else if (e.button === 4) {
      e.preventDefault();
      e.stopPropagation();
      navigateForward();
    }
  });

  window.addEventListener('auxclick', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
    }
  });

  // Windows OS AppCommand hooks from Electron main process
  if (window.api && window.api.onNavBack) {
    window.api.onNavBack(() => navigateBack());
  }
  if (window.api && window.api.onNavForward) {
    window.api.onNavForward(() => navigateForward());
  }

  // Home View Renderer (User Collection)
  function renderHomeView() {
    if (!homeCardsGrid) return;
    if (homeFavCount) homeFavCount.textContent = `${favorites.length} треков`;

    homeCardsGrid.innerHTML = '';

    if (!favorites.length) {
      homeCardsGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1; padding: 48px 24px; text-align: center;">
          <div class="empty-icon" style="font-size: 2.2rem; margin-bottom: 12px; color: var(--neon-cyan);">⚡</div>
          <h3 style="font-family: var(--font-tech); text-transform: uppercase; letter-spacing: 1.5px; color: var(--cyber-text-bright); margin-bottom: 8px;">Коллекция пуста</h3>
          <p style="color: var(--cyber-text-dim); font-size: 0.9rem; max-width: 440px; margin: 0 auto 20px;">Ищи любимые треки через поиск вверху и сохраняй их в коллекцию по клику на ❤️</p>
          <button class="btn-hero-play" style="margin: 0 auto; padding: 9px 22px; font-size: 0.82rem;" id="btnHomeGoSearch">
            <span>Перейти к поиску</span>
          </button>
        </div>
      `;
      const btnHomeGoSearch = document.getElementById('btnHomeGoSearch');
      if (btnHomeGoSearch) {
        btnHomeGoSearch.addEventListener('click', () => {
          searchInput.focus();
        });
      }
      return;
    }

    favorites.forEach((t, idx) => {
      const card = document.createElement('div');
      card.className = `music-card ${currentTrack && currentTrack.id === t.id ? 'playing' : ''}`;
      card.dataset.id = t.id;

      card.innerHTML = `
        <div class="card-artwork-box">
          ${t.artworkUrl ? `<img src="${t.artworkUrl}" alt="Cover" loading="lazy">` : `<div class="artwork-fallback" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.2rem;background:#0d121f;color:var(--neon-cyan);">♪</div>`}
          <button class="card-play-btn" title="Слушать">
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 18 12 6 20 6 4"></polygon></svg>
          </button>
        </div>
        <div class="card-info">
          <div class="card-title" title="${esc(t.title)}">${esc(t.title)}</div>
          <div class="card-artist" title="Открыть профиль автора">${esc(t.artist)}</div>
        </div>
      `;

      // Play button on card
      card.querySelector('.card-play-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        setQueue(favorites, idx);
        playTrack(t);
      });

      // Click card
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-artist')) return;
        setQueue(favorites, idx);
        playTrack(t);
      });

      // Click artist
      card.querySelector('.card-artist').addEventListener('click', (e) => {
        e.stopPropagation();
        if (t.source === 'local') {
          showToast(`Исполнитель: ${t.artist}`);
          return;
        }
        if (t.artistId) {
          openArtistProfile(t.artistId);
        } else if (t.artist) {
          performSearch(t.artist);
        } else {
          showToast(`Артист: ${t.artist}`);
        }
      });

      homeCardsGrid.appendChild(card);
    });
  }

  const btnShuffleFavsHome = document.getElementById('btnShuffleFavsHome');
  if (btnShuffleFavsHome) {
    btnShuffleFavsHome.addEventListener('click', () => {
      if (favorites.length) {
        isShuffle = true;
        btnShuffle.classList.add('active');
        const allIndices = fisherYatesShuffle(favorites.map((_, i) => i));
        const firstIdx = allIndices[0];
        setQueue(favorites, firstIdx);
        shuffleDeck = allIndices.slice(1);
        shuffleHistory = [firstIdx];
        shuffleHistoryIndex = 0;
        playTrack(favorites[firstIdx]);
        showToast('Перемешивание запущено: любимые треки без повторов');
      } else {
        searchInput.focus();
        showToast('Коллекция пуста. Найди треки через поиск');
      }
    });
  }

  if (btnPlayFavsHome) {
    btnPlayFavsHome.addEventListener('click', () => {
      if (favorites.length) {
        if (isShuffle) {
          const allIndices = fisherYatesShuffle(favorites.map((_, i) => i));
          const firstIdx = allIndices[0];
          setQueue(favorites, firstIdx);
          shuffleDeck = allIndices.slice(1);
          shuffleHistory = [firstIdx];
          shuffleHistoryIndex = 0;
          playTrack(favorites[firstIdx]);
        } else {
          setQueue(favorites, 0);
          playTrack(favorites[0]);
        }
      } else {
        searchInput.focus();
        showToast('Коллекция пуста. Найди треки через поиск');
      }
    });
  }

  // Playback Telemetry & Stats Engine
  function seedStatsIfEmpty() {
    if (!playStats.tracks) playStats.tracks = {};
    if (!playStats.artists) playStats.artists = {};
  }

  function recordTrackPlay(track) {
    if (!track || !track.title) return;
    if (!playStats.tracks) playStats.tracks = {};
    if (!playStats.artists) playStats.artists = {};

    const tid = String(track.id);
    if (!playStats.tracks[tid]) {
      playStats.tracks[tid] = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        artworkUrl: track.artworkUrl || '',
        durationMs: track.durationMs || 0,
        plays: 0,
        lastPlayed: Date.now()
      };
    }
    playStats.tracks[tid].plays += 1;
    playStats.tracks[tid].lastPlayed = Date.now();

    const akey = (track.artist || 'Неизвестный исполнитель').trim().toLowerCase();
    if (!playStats.artists[akey]) {
      playStats.artists[akey] = {
        name: track.artist || 'Неизвестный исполнитель',
        artistId: track.artistId || null,
        avatarUrl: track.artistAvatar || track.artworkUrl || '',
        plays: 0,
        lastPlayed: Date.now()
      };
    }
    playStats.artists[akey].plays += 1;
    playStats.artists[akey].lastPlayed = Date.now();
    if (track.artistId && !playStats.artists[akey].artistId) {
      playStats.artists[akey].artistId = track.artistId;
    }
    if (track.artistAvatar && !playStats.artists[akey].avatarUrl) {
      playStats.artists[akey].avatarUrl = track.artistAvatar;
    }

    try {
      localStorage.setItem('pulse_play_stats', JSON.stringify(playStats));
    } catch (e) {
      console.warn('Failed to save play stats:', e);
    }
  }

  function formatPlaysWord(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 19) return `${n} прослушиваний`;
    if (mod10 === 1) return `${n} прослушивание`;
    if (mod10 >= 2 && mod10 <= 4) return `${n} прослушивания`;
    return `${n} прослушиваний`;
  }

  function renderStatsView() {
    if (!viewStats) return;
    seedStatsIfEmpty();

    const tracksArr = Object.values(playStats.tracks || {});
    const artistsArr = Object.values(playStats.artists || {});

    const totalPlays = tracksArr.reduce((sum, t) => sum + (t.plays || 0), 0);
    const uniqueTracks = tracksArr.length;

    const sortedTracks = [...tracksArr].sort((a, b) => (b.plays || 0) - (a.plays || 0));
    const sortedArtists = [...artistsArr].sort((a, b) => (b.plays || 0) - (a.plays || 0));

    if (statsTotalPlays) statsTotalPlays.textContent = totalPlays;
    if (statsUniqueTracks) statsUniqueTracks.textContent = uniqueTracks;

    const topArtistObj = sortedArtists[0];
    if (statsTopArtist) {
      statsTopArtist.textContent = topArtistObj ? topArtistObj.name : '—';
    }

    // Render Top Tracks
    if (statsTopTracksList) {
      statsTopTracksList.innerHTML = '';
      if (!sortedTracks.length) {
        statsTopTracksList.innerHTML = `<p style="color:var(--text-muted); padding:20px 0; text-align:center;">Статистика пока пуста. Запусти треки, чтобы сформировать отчёт.</p>`;
      } else {
        sortedTracks.slice(0, 30).forEach((t, i) => {
          const item = document.createElement('div');
          item.className = 'stats-item-row';
          item.innerHTML = `
            <div class="stats-rank">#${i + 1}</div>
            <img class="stats-thumb" src="${t.artworkUrl || ''}" alt="Cover" loading="lazy">
            <div class="stats-item-info">
              <div class="stats-item-title" title="${esc(t.title)}">${esc(t.title)}</div>
              <div class="stats-item-artist">${esc(t.artist)}</div>
            </div>
            <div class="stats-plays-badge">${formatPlaysWord(t.plays || 0)}</div>
          `;
          item.addEventListener('click', () => {
            setQueue([t], 0);
            playTrack(t);
          });
          statsTopTracksList.appendChild(item);
        });
      }
    }

    // Render Top Artists
    if (statsTopArtistsList) {
      statsTopArtistsList.innerHTML = '';
      if (!sortedArtists.length) {
        statsTopArtistsList.innerHTML = `<p style="color:var(--text-muted); padding:20px 0; text-align:center;">Статистика пока пуста. Запусти треки, чтобы сформировать отчёт.</p>`;
      } else {
        sortedArtists.slice(0, 30).forEach((a, i) => {
          const item = document.createElement('div');
          item.className = 'stats-item-row';
          item.innerHTML = `
            <div class="stats-rank">#${i + 1}</div>
            <img class="stats-thumb stats-thumb-artist" src="${a.avatarUrl || ''}" alt="Artist" loading="lazy">
            <div class="stats-item-info">
              <div class="stats-item-title">${esc(a.name)}</div>
              <div class="stats-item-artist">Исполнитель</div>
            </div>
            <div class="stats-plays-badge">${formatPlaysWord(a.plays || 0)}</div>
          `;
          item.addEventListener('click', () => {
            if (a.artistId) {
              openArtistProfile(a.artistId);
            } else if (a.name) {
              performSearch(a.name);
            }
          });
          statsTopArtistsList.appendChild(item);
        });
      }
    }
  }

  // Artist Subtabs Logic
  let currentArtistTab = 'tracks';
  function switchArtistSubtab(tabName) {
    currentArtistTab = tabName;
    document.querySelectorAll('.artist-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.artTab === tabName);
    });
    artistPaneTracks.style.display = tabName === 'tracks' ? 'block' : 'none';
    artistPaneAlbums.style.display = tabName === 'albums' ? 'block' : 'none';
    artistPanePlaylists.style.display = tabName === 'playlists' ? 'block' : 'none';
    artistPaneBio.style.display = tabName === 'bio' ? 'block' : 'none';
  }

  document.querySelectorAll('.artist-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchArtistSubtab(btn.dataset.artTab);
    });
  });

  function renderAlbumCards(items, targetGrid, isPlaylist = false) {
    targetGrid.innerHTML = '';
    if (!items || !items.length) {
      targetGrid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;"><h3>${isPlaylist ? 'Нет публичных плейлистов' : 'Нет релизов или альбомов'}</h3></div>`;
      return;
    }

    items.forEach(alb => {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.innerHTML = `
        <div class="album-artwork-box">
          <img src="${alb.artworkUrl || ''}" alt="Cover" loading="lazy">
          <button class="album-play-btn" title="Слушать релиз">
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 18 12 6 20 6 4"></polygon></svg>
          </button>
        </div>
        <div class="album-info">
          <div class="album-title" title="${alb.title}">${alb.title}</div>
          <div class="album-meta-row">
            <span>${alb.releaseYear || (isPlaylist ? 'Плейлист' : 'Альбом')}</span>
            <span>${alb.trackCount} треков</span>
          </div>
        </div>
      `;

      // Click play button on album
      card.querySelector('.album-play-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (alb.tracks && alb.tracks.length) {
          setQueue(alb.tracks, 0);
          playTrack(alb.tracks[0]);
          showToast(`Воспроизведение: ${alb.title}`);
        } else {
          showToast('Треки этого релиза еще не загружены');
        }
      });

      // Click album card body -> expand tracks in tracks tab
      card.addEventListener('click', () => {
        if (alb.tracks && alb.tracks.length) {
          switchArtistSubtab('tracks');
          artistTracksList.innerHTML = '';
          const headerNotice = document.createElement('div');
          headerNotice.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px; background:rgba(255,85,0,0.1); border-radius:8px; border:1px solid rgba(255,85,0,0.3); margin-bottom:12px;';
          headerNotice.innerHTML = `
            <div><strong>${alb.title}</strong> (${alb.trackCount} треков)</div>
            <button id="btnShowAllTracks" style="background:none; border:none; color:var(--accent-sc); font-weight:700; cursor:pointer;">Все треки автора</button>
          `;
          artistTracksList.appendChild(headerNotice);
          headerNotice.querySelector('#btnShowAllTracks').addEventListener('click', () => {
            if (currentArtistData && currentArtistData.tracks) {
              renderTrackRows(currentArtistData.tracks, artistTracksList);
            }
          });
          renderTrackRows(alb.tracks, artistTracksList);
        } else {
          showToast('У этого альбома нет доступных стрим-треков');
        }
      });

      targetGrid.appendChild(card);
    });
  }

  // Artist Profile Page Logic
  async function openArtistProfile(artistId) {
    if (!artistId) return;
    switchView('artist');
    switchArtistSubtab('tracks');

    artistName.textContent = 'Загрузка автора...';
    artistRealName.style.display = 'none';
    artistVerifiedBadge.style.display = 'none';
    artistFollowers.textContent = '...';
    artistTrackCount.textContent = '...';
    artistAlbumCount.textContent = '...';
    artistLocation.style.display = 'none';
    artistLocationDot.style.display = 'none';
    artistBanner.style.backgroundImage = 'none';

    artistTracksList.innerHTML = `
      <div class="loader-container">
        <div class="spinner"></div>
        <p>Загрузка дискографии и альбомов...</p>
      </div>
    `;
    artistAlbumsGrid.innerHTML = '';
    artistPlaylistsGrid.innerHTML = '';

    try {
      const data = await window.api.getArtistProfile(artistId);
      currentArtistData = data;
      const { artist, tracks, albums, playlists } = data;

      artistName.textContent = artist.username;

      if (artist.fullName && artist.fullName !== artist.username) {
        artistRealName.textContent = artist.fullName;
        artistRealName.style.display = 'block';
      }

      if (artist.verified) {
        artistVerifiedBadge.style.display = 'inline-block';
      }

      artistFollowers.textContent = formatNumber(artist.followersCount);
      artistTrackCount.textContent = tracks.length;
      artistAlbumCount.textContent = albums.length;

      tabBadgeTracks.textContent = tracks.length;
      tabBadgeAlbums.textContent = albums.length;
      tabBadgePlaylists.textContent = playlists.length;

      // Location
      const locParts = [artist.city, artist.country].filter(Boolean);
      if (locParts.length) {
        artistLocation.textContent = locParts.join(', ');
        artistLocation.style.display = 'inline';
        artistLocationDot.style.display = 'inline';
      }

      // Banner
      if (artist.bannerUrl) {
        artistBanner.style.backgroundImage = `url("${artist.bannerUrl}")`;
      } else {
        artistBanner.style.backgroundImage = 'linear-gradient(135deg, #181922 0%, #13141b 100%)';
      }

      // Avatar
      if (artist.avatarUrl) {
        artistAvatarImg.src = artist.avatarUrl;
        artistAvatarImg.style.display = 'block';
        artistAvatarFallback.style.display = 'none';
      } else {
        artistAvatarImg.style.display = 'none';
        artistAvatarFallback.textContent = (artist.username[0] || 'A').toUpperCase();
        artistAvatarFallback.style.display = 'flex';
      }

      // External Link & Play All
      btnArtistOpenWeb.onclick = () => {
        if (artist.permalinkUrl) window.open(artist.permalinkUrl);
      };

      btnArtistPlayAll.onclick = () => {
        if (tracks.length) {
          setQueue(tracks, 0);
          playTrack(tracks[0]);
        }
      };

      // Render Tracks
      if (!tracks.length) {
        artistTracksList.innerHTML = `<div class="empty-state"><h3>У автора нет доступных треков</h3></div>`;
      } else {
        renderTrackRows(tracks, artistTracksList);
      }

      // Render Albums & Playlists
      renderAlbumCards(albums, artistAlbumsGrid, false);
      renderAlbumCards(playlists, artistPlaylistsGrid, true);

      // Bio pane
      artistBioText.textContent = artist.description ? artist.description.trim() : 'Исполнитель не указал биографию.';
      bioLikes.textContent = formatNumber(artist.likesCount);
      bioPlaylists.textContent = formatNumber(artist.playlistCount);
      bioUserId.textContent = String(artist.id);

    } catch (err) {
      console.error('Failed to open artist:', err);
      artistTracksList.innerHTML = `<div class="empty-state"><h3>Ошибка загрузки профиля</h3><p>${err.message}</p></div>`;
      showToast('Не удалось загрузить автора');
    }
  }

  // Click artist or artwork in player bar to open profile or search
  playerArtist.addEventListener('click', () => {
    if (!currentTrack) return;
    if (currentTrack.artistId) {
      openArtistProfile(currentTrack.artistId);
    } else if (currentTrack.artist) {
      performSearch(currentTrack.artist);
    }
  });

  if (playerArtworkWrapper) {
    playerArtworkWrapper.style.cursor = 'pointer';
    playerArtworkWrapper.title = 'Развернуть обложку и караоке (Now Playing)';
    playerArtworkWrapper.addEventListener('click', () => {
      toggleLyrics();
    });
  }

  // Search Logic
  async function performSearch(query) {
    if (!query || !query.trim()) return;
    switchView('search');

    viewTitle.textContent = `Поиск: "${query}"`;
    searchInitialState.style.display = 'none';
    tracksList.style.display = 'none';
    searchLoader.style.display = 'flex';
    searchLoaderText.textContent = `Поиск в ${currentSource === 'soundcloud' ? 'SoundCloud' : 'YouTube'}...`;

    try {
      const results = await window.api.searchTracks(query, currentSource);
      searchLoader.style.display = 'none';
      tracksList.style.display = 'flex';

      const qLower = query.toLowerCase().trim();
      const matchedLocal = localTracks.filter(lt =>
        (lt.title && lt.title.toLowerCase().includes(qLower)) ||
        (lt.artist && lt.artist.toLowerCase().includes(qLower))
      );
      const combined = [...matchedLocal, ...(results || [])];

      if (!combined || combined.length === 0) {
        tracksList.innerHTML = `<div class="empty-state"><h3>Ничего не найдено</h3><p>Попробуй изменить поисковый запрос</p></div>`;
        resultsCount.textContent = '0 треков';
        return;
      }

      resultsCount.textContent = `${combined.length} треков`;
      renderTrackRows(combined, tracksList);
    } catch (err) {
      searchLoader.style.display = 'none';
      tracksList.style.display = 'flex';
      tracksList.innerHTML = `<div class="empty-state"><h3>Ошибка поиска</h3><p>${err.message}</p></div>`;
      showToast('Ошибка при поиске');
    }
  }

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      performSearch(searchInput.value);
    }
  });

  searchInput.addEventListener('input', () => {
    searchClearBtn.style.display = searchInput.value ? 'block' : 'none';
  });

  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchClearBtn.style.display = 'none';
    searchInput.focus();
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.query;
      searchInput.value = q;
      searchClearBtn.style.display = 'block';
      performSearch(q);
    });
  });

  document.querySelectorAll('.source-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      if (pill.dataset.source === 'youtube' && pill.getAttribute('data-disabled') === 'true') {
        showToast('Поиск YouTube недоступен: yt-dlp не обнаружен в системе');
        return;
      }
      document.querySelectorAll('.source-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentSource = pill.dataset.source;
      if (searchInput.value.trim()) {
        performSearch(searchInput.value.trim());
      }
    });
  });

  // Render Track Rows
  function renderTrackRows(tracks, targetContainer) {
    targetContainer.innerHTML = '';
    tracks.forEach((t, idx) => {
      const isFav = favorites.some(f => f.id === t.id);
      const isCurrent = currentTrack && currentTrack.id === t.id;
      const isLocal = t.source === 'local';

      const row = document.createElement('div');
      row.className = `track-row ${isCurrent ? 'playing' : ''}`;
      row.dataset.id = t.id;

      const sourceLabel = isLocal ? 'LOCAL' : (t.source === 'soundcloud' ? 'SC' : 'YT');
      const badgeClass = isLocal ? 'row-source-badge badge-local' : 'row-source-badge';

      row.innerHTML = `
        <div class="row-index">
          ${isCurrent && isPlaying ? `
            <div class="mini-equalizer">
              <span></span><span></span><span></span>
            </div>
          ` : (idx + 1)}
        </div>
        <div class="row-artwork">
          ${t.artworkUrl ? `<img src="${t.artworkUrl}" alt="cover" loading="lazy">` : `<div class="row-artwork-fallback">♪</div>`}
          <div class="row-play-overlay">
            <svg viewBox="0 0 24 24"><polygon points="6 4 18 12 6 20 6 4"></polygon></svg>
          </div>
        </div>
        <div class="row-info">
          <div class="row-title" title="${esc(t.title)}">${esc(t.title)}</div>
          <div class="row-meta">
            <span class="row-artist-link" title="Открыть автора">${esc(t.artist)}</span>
            <span class="${badgeClass}">${sourceLabel}</span>
          </div>
        </div>
        <div class="row-actions">
          ${isLocal ? '' : `
            <button class="btn-icon-action btn-row-wave" title="Запустить Волну от этого трека">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 5-4 7 0"></path>
                <path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0 5-3 7 0"></path>
              </svg>
            </button>
          `}
          <button class="btn-icon-action btn-fav ${isFav ? 'liked' : ''}" title="${isFav ? 'Убрать из любимых' : 'В любимые'}">
            <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
            </svg>
          </button>
          ${isLocal ? `
            <button class="btn-icon-action btn-delete-local" title="Убрать из списка локальных треков">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          ` : `
            <button class="btn-icon-action btn-download" title="Скачать MP3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
            </button>
          `}
        </div>
        <div class="row-duration">${formatMs(t.durationMs)}</div>
      `;

      // Play row
      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-icon-action') || e.target.closest('.row-artist-link')) return;
        setQueue(tracks, idx);
        playTrack(t);
      });

      // Click Artist Name
      const artistLink = row.querySelector('.row-artist-link');
      artistLink.addEventListener('click', (e) => {
        e.stopPropagation();
        if (t.source === 'local') {
          showToast(`Исполнитель: ${t.artist}`);
          return;
        }
        if (t.artistId) {
          openArtistProfile(t.artistId);
        } else if (t.artist) {
          performSearch(t.artist);
        } else {
          showToast(`Артист: ${t.artist}`);
        }
      });

      // Actions
      const waveRowBtn = row.querySelector('.btn-row-wave');
      if (waveRowBtn) {
        waveRowBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          startWave(t);
        });
      }

      const favBtn = row.querySelector('.btn-fav');
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(t);
        favBtn.classList.toggle('liked');
        favBtn.querySelector('svg').setAttribute('fill', favBtn.classList.contains('liked') ? 'currentColor' : 'none');
      });

      const downloadBtn = row.querySelector('.btn-download');
      if (downloadBtn) {
        downloadBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          triggerDownload(t);
        });
      }

      const delBtn = row.querySelector('.btn-delete-local');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          localTracks = localTracks.filter(lt => lt.id !== t.id);
          saveLocalTracks();
          showToast(`Удален из списка: ${t.title}`);
          const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
          if (activeTab === 'local') {
            handleSidebarTab('local');
          }
        });
      }

      targetContainer.appendChild(row);
    });
  }

  function setQueue(tracks, index) {
    queue = [...tracks];
    queueIndex = index;
    if (isShuffle) {
      initShuffleDeck(index);
    } else {
      shuffleDeck = [];
      shuffleHistory = [];
      shuffleHistoryIndex = -1;
    }
    updateBadgeCounts();
  }

  // Playback Engine
  async function playTrack(track) {
    if (!track) return;
    initWebAudio();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    currentTrack = track;
    updatePlayerMeta(track);
    highlightPlayingRow();
    trackStatsRecorded = false;

    if (isLyricsOpen) {
      loadLyrics();
    }

    showToast(`Загрузка потока: ${track.title}...`);

    try {
      const resolved = await window.api.resolveStream(track);

      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }

      if (resolved.protocol === 'hls' && Hls.isSupported()) {
        hlsInstance = new Hls({ maxBufferLength: 30 });
        hlsInstance.loadSource(resolved.streamUrl);
        hlsInstance.attachMedia(audio);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          audio.play().catch(e => console.warn('Play interrupted:', e));
        });
        hlsInstance.on(Hls.Events.ERROR, async (event, data) => {
          if (data.fatal) {
            console.error('HLS fatal error:', data);
            if (hlsRetryCount < 2) {
              hlsRetryCount++;
              const resumePos = audio.currentTime || 0;
              console.log(`[HLS] Recovery attempt ${hlsRetryCount}/2 at ${resumePos}s...`);
              try {
                const refreshed = await window.api.resolveStream(track);
                if (hlsInstance) {
                  hlsInstance.destroy();
                }
                hlsInstance = new Hls({ maxBufferLength: 30 });
                hlsInstance.loadSource(refreshed.streamUrl);
                hlsInstance.attachMedia(audio);
                hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                  if (resumePos > 0) audio.currentTime = resumePos;
                  audio.play().catch(e => console.warn('HLS retry play error:', e));
                });
              } catch (e) {
                console.error('[HLS] Recovery failed:', e);
                showToast('Ошибка восстановления HLS стрима');
              }
            } else {
              showToast('Ошибка HLS стриминга');
            }
          }
        });
      } else {
        audio.src = resolved.streamUrl;
        audio.play().catch(e => console.warn('Play interrupted:', e));
      }

      // Add to history
      history = history.filter(h => h.id !== track.id);
      history.unshift(track);
      if (history.length > 50) history.pop();
      try {
        localStorage.setItem('pulse_history', JSON.stringify(history));
      } catch (e) {}

      updateMediaSession(track);
      syncDiscordPresence(true);
    } catch (err) {
      console.error('Play track failed:', err);
      showToast(`Ошибка воспроизведения: ${err.message}`);
    }
  }

  function updatePlayerMeta(track) {
    playerTitle.textContent = track.title;
    playerArtist.textContent = track.artist;

    if (hudAudioRate) {
      const rateKHz = audioCtx?.sampleRate ? (audioCtx.sampleRate / 1000).toFixed(1) : '48.0';
      const srcTag = track.source === 'local' ? 'LOCAL' : (track.source === 'youtube' ? 'OPUS' : 'AAC');
      hudAudioRate.textContent = `${rateKHz} kHz | ${srcTag}`;
    }

    if (track.artworkUrl) {
      playerArtwork.src = track.artworkUrl;
      playerArtwork.style.display = 'block';
      playerArtworkFallback.style.display = 'none';
      if (lyricsBackdrop) {
        lyricsBackdrop.style.backgroundImage = `url("${track.artworkUrl}")`;
      }
    } else {
      playerArtwork.style.display = 'none';
      playerArtworkFallback.style.display = 'flex';
      if (lyricsBackdrop) {
        lyricsBackdrop.style.backgroundImage = 'none';
      }
    }

    const isFav = favorites.some(f => f.id === track.id);
    playerLikeBtn.classList.toggle('liked', isFav);

    // Update Focus Stage Elements
    if (focusTrackTitle) focusTrackTitle.textContent = track.title;
    if (focusTrackArtist) focusTrackArtist.textContent = track.artist;
    if (focusTagSource) focusTagSource.textContent = (track.source || 'AUDIO').toUpperCase();
    if (focusTagRate && hudAudioRate) focusTagRate.textContent = hudAudioRate.textContent;
    if (focusTagDuration) {
      focusTagDuration.textContent = formatTime(audio.duration || (track.durationMs / 1000));
    }
    if (focusLikeBtn) {
      focusLikeBtn.classList.toggle('liked', isFav);
      focusLikeBtn.querySelector('svg')?.setAttribute('fill', isFav ? 'currentColor' : 'none');
    }

    const stageArt = track.artworkUrl || track.remoteArtworkUrl || '';
    if (stageArt) {
      if (focusArtworkImg) {
        focusArtworkImg.src = stageArt;
        focusArtworkImg.style.display = 'block';
      }
      if (focusArtFallback) focusArtFallback.style.display = 'none';
      if (focusAmbientBackdrop) focusAmbientBackdrop.style.backgroundImage = `url("${stageArt}")`;
      if (focusArtGlow) focusArtGlow.style.backgroundImage = `url("${stageArt}")`;
    } else {
      if (focusArtworkImg) focusArtworkImg.style.display = 'none';
      if (focusArtFallback) focusArtFallback.style.display = 'flex';
      if (focusAmbientBackdrop) focusAmbientBackdrop.style.backgroundImage = 'none';
      if (focusArtGlow) focusArtGlow.style.backgroundImage = 'none';
    }

    if (focusArtCard) {
      focusArtCard.classList.toggle('playing', isPlaying);
    }
  }

  function highlightPlayingRow() {
    // Highlights in lists
    document.querySelectorAll('.track-row').forEach(row => {
      const isCur = currentTrack && row.dataset.id === currentTrack.id;
      row.classList.toggle('playing', isCur);
      const idxEl = row.querySelector('.row-index');
      if (idxEl) {
        if (isCur && isPlaying) {
          idxEl.innerHTML = `<div class="mini-equalizer"><span></span><span></span><span></span></div>`;
        } else {
          const parent = row.parentElement;
          const defaultIdx = Array.from(parent.children).indexOf(row) + 1;
          idxEl.textContent = defaultIdx;
        }
      }
    });

    // Highlights in music cards
    document.querySelectorAll('.music-card').forEach(card => {
      const isCur = currentTrack && card.dataset.id === currentTrack.id;
      card.classList.toggle('playing', isCur);
    });

    // Mini EQ in player
    playerMiniEq.style.display = isPlaying ? 'inline-flex' : 'none';
  }

  function togglePlay() {
    if (!currentTrack) {
      if (queue.length > 0) { queueIndex = 0; playTrack(queue[0]); }
      return;
    }
    if (audio.paused) {
      if (!audio.src && !audio.currentSrc) {
        const savedPos = lastSession?.track?.id === currentTrack.id
          ? (lastSession.position || 0)
          : 0;
        playTrack(currentTrack).then(() => {
          if (savedPos > 0 && audio.duration) audio.currentTime = savedPos;
        }).catch(err => showToast(`Не удалось воспроизвести: ${err.message}`));
      } else {
        audio.play().catch(() => showToast('Не удалось запустить воспроизведение'));
      }
    } else {
      audio.pause();
    }
  }

  function playNext() {
    if (!queue.length) return;

    if (isWaveMode && audio.currentTime < 8 && currentTrack) {
      waveRecentTracks.push(currentTrack, currentTrack, currentTrack, currentTrack);
      const skippedKeywords = extractTrackKeywords(currentTrack);
      wavePool = wavePool.filter(t => {
        const candKeywords = extractTrackKeywords(t);
        for (const kw of candKeywords) {
          if (skippedKeywords.has(kw)) return false;
        }
        return true;
      });
    }

    if (isWaveMode) {
      queueIndex = (queueIndex + 1) % queue.length;
      if (queueIndex >= queue.length - 4) {
        expandWavePoolAndRefillQueue();
      }
      playTrack(queue[queueIndex]);
      return;
    }

    if (isShuffle && queue.length > 1) {
      // 1. History traversal forward if user previously used playPrev
      if (shuffleHistoryIndex < shuffleHistory.length - 1) {
        shuffleHistoryIndex++;
        queueIndex = shuffleHistory[shuffleHistoryIndex];
        playTrack(queue[queueIndex]);
        return;
      }

      // 2. Next track from Fisher-Yates deck
      if (shuffleDeck.length === 0) {
        const allIndices = queue.map((_, i) => i);
        let newDeck = fisherYatesShuffle(allIndices);
        if (newDeck.length > 1 && newDeck[0] === queueIndex) {
          const swapIdx = newDeck.length - 1;
          [newDeck[0], newDeck[swapIdx]] = [newDeck[swapIdx], newDeck[0]];
        }
        shuffleDeck = newDeck;
      }

      const nextIdx = shuffleDeck.shift();
      queueIndex = nextIdx;
      shuffleHistory.push(queueIndex);
      if (shuffleHistory.length > 100) shuffleHistory.shift();
      shuffleHistoryIndex = shuffleHistory.length - 1;
      playTrack(queue[queueIndex]);
      return;
    }

    queueIndex = (queueIndex + 1) % queue.length;
    playTrack(queue[queueIndex]);
  }

  function playPrev() {
    if (!queue.length) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }

    if (!isWaveMode && isShuffle && queue.length > 1 && shuffleHistory.length > 0) {
      if (shuffleHistoryIndex > 0) {
        shuffleHistoryIndex--;
        queueIndex = shuffleHistory[shuffleHistoryIndex];
        playTrack(queue[queueIndex]);
        return;
      } else {
        audio.currentTime = 0;
        return;
      }
    }

    queueIndex = (queueIndex - 1 + queue.length) % queue.length;
    playTrack(queue[queueIndex]);
  }

  // Audio Events
  audio.addEventListener('play', () => {
    isPlaying = true;
    hlsRetryCount = 0;
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    highlightPlayingRow();
    if (focusArtCard) focusArtCard.classList.add('playing');
    syncDiscordPresence(true);
  });

  audio.addEventListener('pause', () => {
    isPlaying = false;
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    highlightPlayingRow();
    if (focusArtCard) focusArtCard.classList.remove('playing');
    syncDiscordPresence(true);
  });

  audio.addEventListener('error', () => {
    const code = audio.error?.code;
    const msg = code === 1 ? 'Загрузка прервана'
              : code === 2 ? 'Ошибка сети'
              : code === 3 ? 'Ошибка декодирования'
              : code === 4 ? 'Формат не поддерживается'
              : 'Неизвестная ошибка';
    console.error('[AUDIO]', msg, audio.error);
    showToast(`Ошибка аудио: ${msg}`);
  });

  audio.addEventListener('seeked', () => {
    syncDiscordPresence(true);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration && Number.isFinite(audio.duration)) {
      totalDurationEl.textContent = formatTime(audio.duration);
      if (currentTrack && currentTrack.source === 'local') {
        if (!currentTrack.durationMs || currentTrack.durationMs === 0) {
          currentTrack.durationMs = Math.round(audio.duration * 1000);
          saveLocalTracks();
        }
      }
      syncDiscordPresence(true);
    }
  });

  audio.addEventListener('playing', () => {
    syncDiscordPresence(true);
  });

  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const cur = audio.currentTime;
    const dur = audio.duration;
    currentTimeEl.textContent = formatTime(cur);
    totalDurationEl.textContent = formatTime(dur);

    const progress = (cur / dur) * 100;
    seekSlider.value = progress;
    seekFill.style.width = `${progress}%`;

    // Persist Session State Throttled (every 3s)
    const now = Date.now();
    if (currentTrack && now - lastSessionSaveTime > 3000) {
      lastSessionSaveTime = now;
      try {
        localStorage.setItem('pulse_last_session', JSON.stringify({
          track: currentTrack,
          position: cur,
          queue: queue.slice(0, 100),
          queueIndex: queueIndex
        }));
      } catch (e) {}
    }

    // Playback Statistics: logged when at least 50% of the track has been played
    if (!trackStatsRecorded && currentTrack && dur > 0 && cur >= dur * 0.5) {
      trackStatsRecorded = true;
      recordTrackPlay(currentTrack);
    }

    // Auto-refill Cyber Wave Queue
    if (isWaveMode && queueIndex >= queue.length - 4 && !isWaveFetching) {
      expandWavePoolAndRefillQueue();
    }

    // Synced Karaoke Lyrics Auto-Scroll & Highlight
    if (isLyricsOpen && isSyncedLyrics && parsedLyrics.length > 0) {
      let targetIdx = -1;
      for (let i = 0; i < parsedLyrics.length; i++) {
        if (cur >= parsedLyrics[i].time) {
          targetIdx = i;
        } else {
          break;
        }
      }

      if (targetIdx !== currentActiveLyricIndex && targetIdx >= 0) {
        const prevEl = lyricsContent.querySelector('.lyric-line.active');
        if (prevEl) prevEl.classList.remove('active');

        const curEl = lyricsContent.children[targetIdx];
        if (curEl) {
          curEl.classList.add('active');
          if (lyricsScrollContainer) {
            const container = lyricsScrollContainer;
            let elTop = curEl.offsetTop;
            let p = curEl.offsetParent;
            while (p && p !== container) {
              elTop += p.offsetTop;
              p = p.offsetParent;
            }
            const targetOffset = (elTop + curEl.offsetHeight / 2) - (container.clientHeight / 2);
            smoothScrollLyricsTo(container, Math.max(0, targetOffset), 380);
          }
        }
        currentActiveLyricIndex = targetIdx;
      }
    }
  });

  audio.addEventListener('ended', () => {
    if (!trackStatsRecorded && currentTrack && audio.duration > 0 && audio.currentTime >= audio.duration * 0.5) {
      trackStatsRecorded = true;
      recordTrackPlay(currentTrack);
    }
    if (repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play();
    } else if (isWaveMode || repeatMode === 'all' || isShuffle || queueIndex < queue.length - 1) {
      playNext();
    } else {
      if (window.api && window.api.clearDiscordRpc) {
        window.api.clearDiscordRpc().catch(() => {});
      }
    }
  });

  // Controls Event Listeners
  btnPlayPause.addEventListener('click', togglePlay);
  btnNext.addEventListener('click', playNext);
  btnPrev.addEventListener('click', playPrev);

  if (btnNavWave) {
    btnNavWave.addEventListener('click', () => toggleWaveMode());
  }

  btnShuffle.addEventListener('click', () => {
    isShuffle = !isShuffle;
    btnShuffle.classList.toggle('active', isShuffle);
    if (isShuffle) {
      initShuffleDeck(queueIndex);
      showToast('Случайный порядок включен (без повторов)');
    } else {
      shuffleDeck = [];
      showToast('Случайный порядок выключен');
    }
  });

  btnRepeat.addEventListener('click', () => {
    if (repeatMode === 'off') {
      repeatMode = 'all';
      btnRepeat.classList.add('active');
      btnRepeat.classList.remove('repeat-one');
      showToast('Повтор всей очереди');
    } else if (repeatMode === 'all') {
      repeatMode = 'one';
      btnRepeat.classList.add('active', 'repeat-one');
      showToast('Повтор одного трека');
    } else {
      repeatMode = 'off';
      btnRepeat.classList.remove('active', 'repeat-one');
      showToast('Повтор выключен');
    }
  });

  seekSlider.addEventListener('input', () => {
    if (!audio.duration) return;
    const target = (seekSlider.value / 100) * audio.duration;
    audio.currentTime = target;
    seekFill.style.width = `${seekSlider.value}%`;
  });

  // ==========================================
  // Cyber Wave Recommendation Engine
  // ==========================================
  const COMMON_STOP_WORDS = new Set([
    'feat', 'ft', 'prod', 'by', 'remix', 'edit', 'vip', 'mix', 'bootleg',
    'official', 'video', 'audio', 'track', 'music', 'slowed', 'reverb',
    'sped', 'up', 'bass', 'boosted', 'sound', 'records', 'tape', 'leak',
    'without', 'lyrics', 'ost', 'version', 'free', 'type', 'beat', 'instrumental',
    'без', 'цензуры', 'ремикс', 'микс', 'слив', 'трек'
  ]);

  function extractTrackKeywords(track) {
    if (!track) return new Set();
    const keywords = new Set();
    const text = ((track.artist || '') + ' ' + (track.title || '')).toLowerCase();
    const tokens = text.match(/[\p{L}\p{N}]{2,}/gu) || [];
    for (const tok of tokens) {
      if (!COMMON_STOP_WORDS.has(tok) && tok.length >= 2) {
        keywords.add(tok);
      }
    }
    if (track.title && /[-—]/.test(track.title)) {
      const prefix = track.title.split(/[-—]/)[0].trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (prefix.length >= 2 && !COMMON_STOP_WORDS.has(prefix)) {
        keywords.add(prefix);
      }
    }
    return keywords;
  }

  function canonicalArtist(track) {
    if (!track) return 'unknown';
    let raw = track.artist || '';
    let titleArtist = '';
    if (track.title && /[-—]/.test(track.title)) {
      const parts = track.title.split(/[-—]/);
      if (parts[0] && parts[0].trim().length >= 2) {
        titleArtist = parts[0].trim().toLowerCase();
      }
    }
    const cleanRaw = raw.toLowerCase().replace(/\s*\(.*\)/g, '').replace(/@/g, '').trim();
    return cleanRaw || titleArtist || 'unknown';
  }

  async function fetchWaveCandidates(seedTrack) {
    if (!seedTrack || !seedTrack.id || seedTrack.source !== 'soundcloud') return [];
    try {
      if (window.api && window.api.getRelatedTracks) {
        const list = await window.api.getRelatedTracks(seedTrack.id);
        return Array.isArray(list) ? list : [];
      }
    } catch (e) {
      console.warn('[WAVE] getRelatedTracks error:', e);
    }
    return [];
  }

  async function expandWavePoolAndRefillQueue() {
    if (!isWaveMode || isWaveFetching) return;
    isWaveFetching = true;
    try {
      if (wavePool.length < 15) {
        const querySeed = (queue.length > 0 ? queue[queue.length - 1] : waveSeedTrack) || waveSeedTrack;
        if (querySeed && querySeed.id) {
          const fresh = await fetchWaveCandidates(querySeed);
          const otherCandidate = fresh.find(t => canonicalArtist(t) !== canonicalArtist(querySeed));
          let secondaryHop = [];
          if (otherCandidate && otherCandidate.id) {
            secondaryHop = await fetchWaveCandidates(otherCandidate);
          }

          const combined = [...fresh, ...secondaryHop];
          const queuedIds = new Set(queue.map(q => String(q.id)));
          wavePool.forEach(p => queuedIds.add(String(p.id)));

          combined.forEach(c => {
            if (!queuedIds.has(String(c.id))) {
              queuedIds.add(String(c.id));
              wavePool.push(c);
            }
          });
        }
      }

      // Add tracks into queue until queue is at least queueIndex + 12
      const targetQueueAhead = 12;
      const needed = Math.max(0, (queueIndex + targetQueueAhead) - queue.length);
      for (let i = 0; i < needed && wavePool.length > 0; i++) {
        // Build set of blocked keywords from recent WAVE_MIN_ARTIST_DISTANCE tracks
        const blockedKeywords = new Set();
        const recentHistorySlice = waveRecentTracks.slice(-WAVE_MIN_ARTIST_DISTANCE);
        recentHistorySlice.forEach(tr => {
          extractTrackKeywords(tr).forEach(k => blockedKeywords.add(k));
        });

        let candidateIdx = wavePool.findIndex(t => {
          const candKeywords = extractTrackKeywords(t);
          for (const kw of candKeywords) {
            if (blockedKeywords.has(kw)) return false; // Overlap detected -> blocked
          }
          return true;
        });

        if (candidateIdx === -1) {
          candidateIdx = 0;
        }
        const chosen = wavePool.splice(candidateIdx, 1)[0];
        waveRecentTracks.push(chosen);
        queue.push(chosen);
      }
      updateBadgeCounts();
    } catch (err) {
      console.warn('[WAVE] Expand error:', err);
    } finally {
      isWaveFetching = false;
    }
  }

  async function startWave(optionalSeed = null) {
    if (optionalSeed && optionalSeed.source === 'local') {
      showToast('Моя Волна доступна только для онлайн-треков (SoundCloud)');
      return;
    }
    let seed = optionalSeed;
    if (!seed) {
      if (currentTrack && currentTrack.source === 'soundcloud') {
        seed = currentTrack;
      } else if (favorites.length > 0) {
        const scFavs = favorites.filter(f => f.source === 'soundcloud');
        seed = scFavs.length > 0 ? scFavs[Math.floor(Math.random() * scFavs.length)] : null;
      }
      if (!seed) {
        const statTracks = Object.values(playStats.tracks || {}).filter(t => t.source === 'soundcloud');
        if (statTracks.length > 0) seed = statTracks[0];
      }
    }

    if (!seed) {
      showToast('Ищу треки для запуска Волны...');
      try {
        const fallbackSearch = await window.api.searchTracks('rap phonk electronic', 'soundcloud');
        if (fallbackSearch && fallbackSearch.length > 0) {
          seed = fallbackSearch[0];
        }
      } catch (e) {}
    }

    if (!seed) {
      showToast('Не удалось запустить Волну: найди хотя бы один трек');
      return;
    }

    isWaveMode = true;
    waveSeedTrack = seed;
    wavePool = [];
    waveRecentTracks = [seed];
    updateWaveUI(true);

    setQueue([seed], 0);
    playTrack(seed);
    showToast(`⚡ Моя Волна запущена: вайб «${seed.artist || seed.title}»`);

    expandWavePoolAndRefillQueue();
  }

  function stopWave() {
    isWaveMode = false;
    wavePool = [];
    updateWaveUI(false);
    showToast('Моя Волна: выключена');
  }

  function toggleWaveMode(optionalSeed = null) {
    if (optionalSeed) {
      startWave(optionalSeed);
      return;
    }
    if (isWaveMode) {
      stopWave();
    } else {
      startWave();
    }
  }

  function updateWaveUI(active) {
    if (btnNavWave) btnNavWave.classList.toggle('wave-active', active);
    if (waveLiveBadge) waveLiveBadge.style.display = active ? 'inline-block' : 'none';
  }

  // Volume
  function updateVolume(val) {
    val = Math.max(0, Math.min(1, val));
    audio.volume = val;
    volumeSlider.value = val;
    volumeFill.style.width = `${val * 100}%`;
    localStorage.setItem('pulse_volume', val);

    if (val === 0) {
      iconVolHigh.style.display = 'none';
      iconVolMuted.style.display = 'block';
    } else {
      iconVolHigh.style.display = 'block';
      iconVolMuted.style.display = 'none';
    }
  }

  volumeSlider.addEventListener('input', () => {
    updateVolume(parseFloat(volumeSlider.value));
  });

  let preMuteVolume = 0.8;
  btnMute.addEventListener('click', () => {
    if (audio.volume > 0) {
      preMuteVolume = audio.volume;
      updateVolume(0);
    } else {
      updateVolume(preMuteVolume || 0.8);
    }
  });

  const savedVol = localStorage.getItem('pulse_volume');
  if (savedVol !== null) updateVolume(parseFloat(savedVol));
  else updateVolume(0.8);

  // Favorites
  function toggleFavorite(track) {
    const idx = favorites.findIndex(f => f.id === track.id);
    if (idx >= 0) {
      favorites.splice(idx, 1);
      showToast(`Удален из любимых: ${track.title}`);
    } else {
      favorites.unshift(track);
      showToast(`Добавлен в любимые: ${track.title}`);
    }
    localStorage.setItem('pulse_favorites', JSON.stringify(favorites));
    if (window.api && window.api.saveFavoritesBackup) {
      window.api.saveFavoritesBackup(favorites).catch(() => {});
    }
    updateBadgeCounts();
    renderHomeView();

    if (currentTrack && currentTrack.id === track.id) {
      playerLikeBtn.classList.toggle('liked', idx < 0);
      if (focusLikeBtn) {
        focusLikeBtn.classList.toggle('liked', idx < 0);
        focusLikeBtn.querySelector('svg')?.setAttribute('fill', idx < 0 ? 'currentColor' : 'none');
      }
    }
  }

  playerLikeBtn.addEventListener('click', () => {
    if (currentTrack) toggleFavorite(currentTrack);
  });

  // Visualizer Toggle
  btnVisualizer.addEventListener('click', () => {
    isVisualizerActive = !isVisualizerActive;
    btnVisualizer.classList.toggle('active', isVisualizerActive);
    canvas.style.display = isVisualizerActive ? 'block' : 'none';
  });

  // Downloads
  async function triggerDownload(track) {
    showToast(`Загрузка на диск: ${track.title}...`);
    try {
      const res = await window.api.downloadTrack(track);
      if (res.success) {
        showToast(`Сохранено: ${track.artist} - ${track.title}`);
      } else {
        showToast(`Ошибка: ${res.message || 'Не удалось скачать'}`);
      }
    } catch (err) {
      showToast(`Ошибка скачивания: ${err.message}`);
    }
  }

  btnDownloadCurrent.addEventListener('click', () => {
    if (currentTrack) triggerDownload(currentTrack);
    else showToast('Нет играющего трека');
  });

  // Discord Rich Presence Sync
  function syncDiscordPresence(force = false) {
    if (!window.api || !window.api.updateDiscordRpc) return;
    if (!isDiscordRpcEnabled) return;
    if (!currentTrack) {
      window.api.clearDiscordRpc().catch(() => {});
      return;
    }

    const now = Date.now();
    if (!force && now - lastDiscordSyncTime < 1500) return;
    lastDiscordSyncTime = now;

    const validAudioDur = (audio.duration && Number.isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0;
    const fallbackTrackDur = currentTrack?.durationMs ? (currentTrack.durationMs / 1000) : 0;
    const dur = validAudioDur || fallbackTrackDur;

    window.api.updateDiscordRpc({
      track: currentTrack,
      isPlaying: isPlaying,
      currentTime: audio.currentTime || 0,
      duration: dur
    }).catch(err => console.warn('Discord RPC sync failed:', err));
  }

  if (btnDiscord) {
    btnDiscord.classList.toggle('active', isDiscordRpcEnabled);
    btnDiscord.title = isDiscordRpcEnabled ? 'Discord Rich Presence (включен)' : 'Discord Rich Presence (выключен)';

    btnDiscord.addEventListener('click', async () => {
      isDiscordRpcEnabled = !isDiscordRpcEnabled;
      localStorage.setItem('pulse_discord_rpc', isDiscordRpcEnabled ? 'true' : 'false');
      btnDiscord.classList.toggle('active', isDiscordRpcEnabled);
      btnDiscord.title = isDiscordRpcEnabled ? 'Discord Rich Presence (включен)' : 'Discord Rich Presence (выключен)';

      if (window.api && window.api.toggleDiscordRpc) {
        await window.api.toggleDiscordRpc(isDiscordRpcEnabled);
      }

      if (isDiscordRpcEnabled) {
        showToast('Discord Rich Presence: включен');
        syncDiscordPresence(true);
      } else {
        showToast('Discord Rich Presence: выключен');
        if (window.api && window.api.clearDiscordRpc) {
          await window.api.clearDiscordRpc();
        }
      }
    });
  }

  // Windows Media Session
  function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.source === 'soundcloud' ? 'SoundCloud' : 'YouTube',
      artwork: track.artworkUrl ? [{ src: track.artworkUrl, sizes: '500x500', type: 'image/jpeg' }] : []
    });

    navigator.mediaSession.setActionHandler('play', togglePlay);
    navigator.mediaSession.setActionHandler('pause', togglePlay);
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime && audio.duration) audio.currentTime = details.seekTime;
    });
  }

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isLyricsOpen) {
      navigateBack();
      return;
    }
    if (document.activeElement === searchInput) return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowRight') {
      if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    } else if (e.code === 'ArrowLeft') {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      updateVolume(audio.volume + 0.05);
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      updateVolume(audio.volume - 0.05);
    }
  });

  // Init
  updateBadgeCounts();
  renderHomeView();

  // Restore Last Session Track Meta
  if (lastSession && lastSession.track) {
    currentTrack = lastSession.track;
    if (Array.isArray(lastSession.queue) && lastSession.queue.length > 0) {
      queue = lastSession.queue;
      queueIndex = typeof lastSession.queueIndex === 'number' ? lastSession.queueIndex : 0;
    } else {
      queue = [currentTrack];
      queueIndex = 0;
    }
    updatePlayerMeta(currentTrack);
    const restoredPos = lastSession.position || 0;
    currentTimeEl.textContent = formatTime(restoredPos);
    if (currentTrack.durationMs) {
      const durSec = currentTrack.durationMs / 1000;
      totalDurationEl.textContent = formatTime(durSec);
      const prog = (restoredPos / durSec) * 100;
      seekSlider.value = prog;
      seekFill.style.width = `${prog}%`;
    }
  }

  // Check yt-dlp binary availability
  if (window.api && window.api.isYtDlpAvailable) {
    window.api.isYtDlpAvailable().then(avail => {
      if (!avail) {
        const ytPill = document.querySelector('.source-pill[data-source="youtube"]');
        if (ytPill) {
          ytPill.setAttribute('data-disabled', 'true');
          ytPill.style.opacity = '0.4';
          ytPill.style.cursor = 'not-allowed';
          ytPill.title = 'yt-dlp не обнаружен в PATH';
        }
      }
    }).catch(() => {});
  }

  if (window.api && window.api.toggleDiscordRpc) {
    window.api.toggleDiscordRpc(isDiscordRpcEnabled).catch(() => {});
  }
})();
