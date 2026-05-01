/* ═══════════════════════════════════════════════════════════════════════════
   SyncPlay — app.js
   Single-file frontend: state, WebSocket, YouTube IFrame API, audio/video
═══════════════════════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────────────
const State = {
  ws: null,
  roomCode: null,
  isHost: false,
  controlMode: 'host',       // 'host' | 'shared'
  content: null,             // { type, url, fileId, filename }
  playState: { action: 'pause', currentTime: 0, videoIndex: 0 },
  ytPlayer: null,
  ytReady: false,
  ytQueue: [],               // array of YouTube video IDs
  localMediaEl: null,        // <audio> or <video> element
  heartbeatInterval: null,
  syncInterval: null,
  username: '',
  reconnectTimer: null,
  isConnected: false,
};

// ─── Local Storage Helpers ────────────────────────────────────────────────
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  pushHistory(type, value) {
    const key = `history_${type}`;
    let list = LS.get(key) || [];
    list = [value, ...list.filter(i => i !== value)].slice(0, 10);
    LS.set(key, list);
  },
  getHistory(type) { return LS.get(`history_${type}`) || []; },
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function fmt(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getYTId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function getYTPlaylistIds(url) {
  const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const listId = m[1];
  // Use oEmbed to verify + noembed for title, but for IDs we use YouTube's
  // undocumented RSS feed which works without an API key
  try {
    const rss = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${listId}`);
    const text = await rss.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');
    const entries = xml.querySelectorAll('entry');
    const ids = [];
    entries.forEach(e => {
      const id = e.querySelector('videoId')?.textContent;
      const title = e.querySelector('title')?.textContent;
      if (id) ids.push({ id, title: title || id });
    });
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

let toastTimer;
function toast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ─── WebSocket Connection ─────────────────────────────────────────────────
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}`);
  State.ws = ws;

  ws.onopen = () => {
    State.isConnected = true;
    document.getElementById('ws-status').classList.remove('visible');
    clearTimeout(State.reconnectTimer);
  };

  ws.onclose = () => {
    State.isConnected = false;
    if (State.roomCode) {
      document.getElementById('ws-status').textContent = '⚡ Reconnecting…';
      document.getElementById('ws-status').classList.add('visible');
      State.reconnectTimer = setTimeout(connectWS, 3000);
    }
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };
}

function send(obj) {
  if (State.ws && State.ws.readyState === WebSocket.OPEN) {
    State.ws.send(JSON.stringify(obj));
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'room-created':
      State.roomCode = msg.roomCode;
      State.isHost = true;
      renderRoom();
      break;

    case 'room-joined':
      State.roomCode = msg.roomCode;
      State.isHost = false;
      State.controlMode = msg.controlMode;
      if (msg.content) applyContent(msg.content, msg.playState);
      renderRoom();
      break;

    case 'content-changed':
      applyContent(msg.content, msg.playState);
      renderPlayerArea();
      renderNowPlaying();
      toast(`▶ Now playing: ${msg.content?.filename || 'YouTube'}`);
      break;

    case 'play-state':
      applyPlayState(msg);
      break;

    case 'control-mode':
      State.controlMode = msg.mode;
      updateControlLock();
      toast(msg.mode === 'shared' ? '🔓 Anyone can control' : '🔒 Host controls only');
      break;

    case 'sync-response':
      State.controlMode = msg.controlMode;
      if (msg.content) applyContent(msg.content, msg.playState);
      break;

    case 'user-joined':
      toast(`👋 ${msg.username} joined`);
      break;

    case 'user-left':
      toast(`${msg.username} left`);
      break;

    case 'host-left':
      toast('Host left the room', 4000);
      stopAllMedia();
      State.roomCode = null;
      State.isHost = false;
      State.content = null;
      renderHome();
      break;

    case 'error':
      toast(`❌ ${msg.message}`);
      break;
  }
}

// ─── Apply Content from Server ────────────────────────────────────────────
function applyContent(content, playState) {
  State.content = content;
  State.playState = playState || { action: 'pause', currentTime: 0, videoIndex: 0 };
  stopAllMedia();
  if (content?.type === 'youtube-playlist') {
    State.ytQueue = content.queue || [];
  }
}

function applyPlayState(ps) {
  State.playState = ps;

  if (State.content?.type === 'local') {
    const el = State.localMediaEl;
    if (!el) return;
    if (Math.abs(el.currentTime - ps.currentTime) > 2) el.currentTime = ps.currentTime;
    ps.action === 'play' ? el.play().catch(() => {}) : el.pause();
    updatePlayButton(ps.action === 'play');
    updateProgress();

  } else if (State.content?.type === 'youtube' || State.content?.type === 'youtube-playlist') {
    const yp = State.ytPlayer;
    if (!yp || !State.ytReady) return;

    if (State.content.type === 'youtube-playlist') {
      const idx = ps.videoIndex || 0;
      const cur = yp.getPlaylistIndex?.();
      if (cur !== idx) yp.playVideoAt?.(idx);
    }

    const yt = yp.getCurrentTime?.() || 0;
    if (Math.abs(yt - ps.currentTime) > 2.5) yp.seekTo?.(ps.currentTime, true);
    ps.action === 'play' ? yp.playVideo?.() : yp.pauseVideo?.();
    updatePlayButton(ps.action === 'play');
  }
}

// ─── Stop All Media ───────────────────────────────────────────────────────
function stopAllMedia() {
  if (State.localMediaEl) {
    State.localMediaEl.pause();
    State.localMediaEl.src = '';
    State.localMediaEl = null;
  }
  if (State.ytPlayer && State.ytReady) {
    try { State.ytPlayer.stopVideo?.(); } catch {}
  }
  State.ytQueue = [];
  clearInterval(State.heartbeatInterval);
  clearInterval(State.syncInterval);
}

// ══════════════════════════════════════════════════════════════════════════
//  RENDER FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

// ─── Root Render ─────────────────────────────────────────────────────────
function render() {
  if (State.roomCode) renderRoom();
  else renderHome();
}

// ─── Home Screen ─────────────────────────────────────────────────────────
function renderHome() {
  const ytHistory = LS.getHistory('youtube');
  const plHistory = LS.getHistory('playlist');
  const roomHistory = LS.getHistory('room');

  document.getElementById('app').innerHTML = `
    <div class="home-screen scroll-y">
      <div class="home-top">
        <div class="logo">SYNCPLAY</div>
        <div class="tagline">Listen together, anywhere</div>
      </div>

      <div class="home-form">
        <div>
          <label class="field-label">Your name</label>
          <input type="text" id="username-input" placeholder="Enter your name…"
            value="${LS.get('username') || ''}" maxlength="20" autocomplete="off" />
        </div>

        <button class="btn btn-primary full-width" id="create-btn" onclick="createRoom()">
          🎵 Create a Room
        </button>

        <div class="divider">or join one</div>

        <div>
          <label class="field-label">Room Code</label>
          <div class="join-row">
            <input type="text" id="room-code-input" placeholder="ABC123"
              maxlength="6" autocomplete="off"
              onkeydown="if(event.key==='Enter') joinRoom()" />
            <button class="btn btn-outline" onclick="joinRoom()">Join</button>
          </div>
        </div>

        ${roomHistory.length ? `
          <div class="home-history">
            <div class="section-title">Recent rooms</div>
            <div>${roomHistory.map(c => `
              <span class="history-chip" onclick="document.getElementById('room-code-input').value='${c}';joinRoom()">
                <span class="chip-icon">🚪</span>${c}
              </span>`).join('')}
            </div>
          </div>` : ''}

        ${ytHistory.length || plHistory.length ? `
          <div class="home-history">
            <div class="section-title">Saved links</div>
            <div>
              ${ytHistory.map(u => `
                <span class="history-chip" title="${u}" onclick="prefillAndCreate('yt','${encodeURIComponent(u)}')">
                  <span class="chip-icon">▶</span>${u}
                </span>`).join('')}
              ${plHistory.map(u => `
                <span class="history-chip" title="${u}" onclick="prefillAndCreate('pl','${encodeURIComponent(u)}')">
                  <span class="chip-icon">📋</span>${u}
                </span>`).join('')}
            </div>
          </div>` : ''}
      </div>
    </div>

    <div id="toast" class="toast"></div>
    <div id="ws-status" class="ws-status">Connecting…</div>
  `;
}

// ─── Room Screen ──────────────────────────────────────────────────────────
function renderRoom() {
  const canControl = State.isHost || State.controlMode === 'shared';

  document.getElementById('app').innerHTML = `
    <div class="room-screen">

      <!-- Header -->
      <div class="room-header">
        <div class="room-info">
          <div>
            <div class="room-label">ROOM</div>
            <div class="room-code-text" onclick="copyCode()" title="Tap to copy">${State.roomCode}</div>
          </div>
        </div>
        <div class="room-right">
          ${State.isHost ? `
            <button class="ctrl-toggle ${State.controlMode === 'shared' ? 'shared' : ''}"
              id="ctrl-toggle-btn" onclick="toggleControlMode()">
              ${State.controlMode === 'shared' ? '🔓 Shared' : '🔒 Host only'}
            </button>` : ''}
          <button class="icon-btn danger" onclick="leaveRoom()" title="Leave">✕</button>
        </div>
      </div>

      <!-- Player Area -->
      <div class="player-area" id="player-area">
        ${renderEmptyPlayer()}
      </div>

      <!-- Now Playing -->
      <div class="now-playing" id="now-playing"></div>

      <!-- Controls -->
      <div class="controls ${canControl ? '' : 'locked'}" id="controls">
        <button class="ctrl-btn" onclick="seek(-10)" title="−10s">⏮</button>
        <button class="ctrl-btn play-main" id="play-btn" onclick="togglePlay()">▶</button>
        <button class="ctrl-btn" onclick="seek(10)" title="+10s">⏭</button>
        ${State.content?.type === 'youtube-playlist' ? `
          <button class="ctrl-btn" onclick="skipVideo(1)" title="Next video">⏩</button>` : ''}
      </div>

      <!-- Bottom Bar -->
      ${State.isHost ? `
        <div class="bottom-bar">
          <button class="btn btn-outline full-width" onclick="openSheet()">
            ＋ Add Content
          </button>
        </div>` : `
        <div class="guest-bar">
          <p>🎧 Listening as guest — ${State.controlMode === 'shared' ? 'you can control' : 'host controls'}</p>
        </div>`}

    </div>

    <!-- Content Sheet -->
    <div class="sheet-backdrop" id="sheet-backdrop" onclick="closeSheet()"></div>
    <div class="content-sheet" id="content-sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <h3>Add Content</h3>
        <button class="icon-btn" onclick="closeSheet()">✕</button>
      </div>
      <div class="tabs">
        <button class="tab-btn active" onclick="switchTab('local')">📁 Local File</button>
        <button class="tab-btn" onclick="switchTab('youtube')">▶ YouTube</button>
        <button class="tab-btn" onclick="switchTab('playlist')">📋 Playlist</button>
      </div>

      <!-- Local File Tab -->
      <div class="tab-panel active" id="tab-local">
        <div class="upload-zone" id="upload-zone" onclick="document.getElementById('file-input').click()"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="handleFileDrop(event)">
          <div class="uz-icon">🎵</div>
          <p>Tap to pick MP3 or MP4</p>
          <p class="hint">Max 200MB • plays for everyone</p>
        </div>
        <input type="file" id="file-input" accept="audio/*,video/*,.mp3,.mp4,.m4a,.webm,.ogg"
          style="display:none" onchange="handleFileSelect(event)" />
        <div class="upload-progress" id="upload-progress">
          <div class="up-bar"><div class="up-fill" id="up-fill"></div></div>
          <div class="up-status" id="up-status">Uploading…</div>
        </div>
      </div>

      <!-- YouTube Tab -->
      <div class="tab-panel" id="tab-youtube">
        <div class="url-row">
          <input type="url" id="yt-input" placeholder="https://youtube.com/watch?v=…" />
          <button class="btn btn-primary" onclick="addYouTube()">Play</button>
        </div>
        <div class="sheet-history" id="yt-history"></div>
      </div>

      <!-- Playlist Tab -->
      <div class="tab-panel" id="tab-playlist">
        <div class="url-row">
          <input type="url" id="pl-input" placeholder="https://youtube.com/playlist?list=…" />
          <button class="btn btn-primary" onclick="addPlaylist()">Load</button>
        </div>
        <div class="sheet-history" id="pl-history"></div>
      </div>
    </div>

    <div id="toast" class="toast"></div>
    <div id="ws-status" class="ws-status">Connecting…</div>
  `;

  renderPlayerArea();
  renderNowPlaying();
  updateControlLock();
  renderSheetHistories();
}

function renderEmptyPlayer() {
  return `
    <div class="empty-player">
      <div class="empty-icon">🎵</div>
      <p>${State.isHost ? 'Tap "Add Content" below to start' : 'Waiting for host to add music…'}</p>
      <p class="hint">Share code <strong>${State.roomCode}</strong> with friends</p>
    </div>`;
}

// ─── Player Area ──────────────────────────────────────────────────────────
function renderPlayerArea() {
  const area = document.getElementById('player-area');
  if (!area) return;
  if (!State.content) { area.innerHTML = renderEmptyPlayer(); return; }

  const c = State.content;

  if (c.type === 'local') {
    area.innerHTML = `
      <div class="audio-wrapper">
        <div class="audio-art" id="audio-art">🎵</div>
      </div>`;
    setupLocalMedia(c);

  } else if (c.type === 'youtube') {
    area.innerHTML = `<div class="yt-wrapper"><div id="yt-player"></div></div>`;
    setupYT([{ id: getYTId(c.url), title: 'Video' }], 0);

  } else if (c.type === 'youtube-playlist') {
    area.innerHTML = `<div class="yt-wrapper"><div id="yt-player"></div></div>`;
    setupYT(State.ytQueue, State.playState.videoIndex || 0);
  }
}

// ─── Now Playing Bar ──────────────────────────────────────────────────────
function renderNowPlaying() {
  const el = document.getElementById('now-playing');
  if (!el || !State.content) return;

  const c = State.content;
  let badge = '', name = '';
  if (c.type === 'local') { badge = 'LOCAL'; name = c.filename || 'Local file'; }
  else if (c.type === 'youtube') { badge = 'YOUTUBE'; name = c.url; }
  else if (c.type === 'youtube-playlist') {
    badge = 'PLAYLIST';
    const idx = State.playState.videoIndex || 0;
    name = State.ytQueue[idx]?.title || 'Playlist';
  }

  el.innerHTML = `
    <div class="now-playing-info">
      <span class="content-badge">${badge}</span>
      <span class="song-name">${name}</span>
    </div>
    <div class="progress-track" onclick="seekByClick(event, this)" id="progress-track">
      <div class="progress-fill" id="progress-fill"></div>
    </div>
    <div class="time-row">
      <span id="time-current">0:00</span>
      <span id="time-total">0:00</span>
    </div>`;
}

// ─── Sheet Histories ──────────────────────────────────────────────────────
function renderSheetHistories() {
  const ytEl = document.getElementById('yt-history');
  const plEl = document.getElementById('pl-history');
  const ytH = LS.getHistory('youtube');
  const plH = LS.getHistory('playlist');

  if (ytEl && ytH.length) {
    ytEl.innerHTML = `<div class="sh-label">Recent</div>` +
      ytH.map(u => `
        <div class="sh-item" onclick="document.getElementById('yt-input').value='${u}';addYouTube()">
          <span class="sh-item-icon">▶</span>
          <span class="sh-item-url">${u}</span>
        </div>`).join('');
  }
  if (plEl && plH.length) {
    plEl.innerHTML = `<div class="sh-label">Recent</div>` +
      plH.map(u => `
        <div class="sh-item" onclick="document.getElementById('pl-input').value='${u}';addPlaylist()">
          <span class="sh-item-icon">📋</span>
          <span class="sh-item-url">${u}</span>
        </div>`).join('');
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  ACTIONS
// ══════════════════════════════════════════════════════════════════════════

function getUsername() {
  const el = document.getElementById('username-input');
  const name = (el?.value.trim() || LS.get('username') || 'User').substring(0, 20);
  LS.set('username', name);
  State.username = name;
  return name;
}

function createRoom() {
  const name = getUsername();
  if (!name) { toast('Enter your name first'); return; }
  send({ type: 'create-room', username: name });
}

function joinRoom() {
  const name = getUsername();
  if (!name) { toast('Enter your name first'); return; }
  const code = (document.getElementById('room-code-input')?.value || '').trim().toUpperCase();
  if (code.length < 4) { toast('Enter a valid room code'); return; }
  LS.pushHistory('room', code);
  send({ type: 'join-room', roomCode: code, username: name });
}

function prefillAndCreate(type, encodedUrl) {
  const url = decodeURIComponent(encodedUrl);
  // auto-create room then load content
  const name = LS.get('username') || 'Host';
  State.username = name;
  send({ type: 'create-room', username: name });
  State._pendingContent = { type, url };
}

function leaveRoom() {
  stopAllMedia();
  if (State.ws) State.ws.close();
  State.roomCode = null;
  State.content = null;
  State.isHost = false;
  State.ytQueue = [];
  setTimeout(connectWS, 300);
  renderHome();
}

function copyCode() {
  navigator.clipboard?.writeText(State.roomCode).then(() => toast('📋 Code copied!'))
    .catch(() => toast(`Code: ${State.roomCode}`));
}

function toggleControlMode() {
  const newMode = State.controlMode === 'shared' ? 'host' : 'shared';
  send({ type: 'toggle-control', mode: newMode });
}

function updateControlLock() {
  const canControl = State.isHost || State.controlMode === 'shared';
  const controls = document.getElementById('controls');
  if (controls) controls.classList.toggle('locked', !canControl);

  // Update toggle button appearance
  const tb = document.getElementById('ctrl-toggle-btn');
  if (tb) {
    tb.textContent = State.controlMode === 'shared' ? '🔓 Shared' : '🔒 Host only';
    tb.classList.toggle('shared', State.controlMode === 'shared');
  }

  // Guest bar text
  const gb = document.querySelector('.guest-bar p');
  if (gb) gb.textContent = `🎧 Listening as guest — ${State.controlMode === 'shared' ? 'you can control' : 'host controls'}`;
}

// ─── Playback Controls ────────────────────────────────────────────────────
function togglePlay() {
  const canControl = State.isHost || State.controlMode === 'shared';
  if (!canControl) return;

  const isPlaying = State.playState.action === 'play';
  const newAction = isPlaying ? 'pause' : 'play';
  let currentTime = 0;

  if (State.content?.type === 'local' && State.localMediaEl) {
    currentTime = State.localMediaEl.currentTime;
  } else if (State.ytPlayer && State.ytReady) {
    currentTime = State.ytPlayer.getCurrentTime?.() || 0;
  }

  State.playState.action = newAction;
  State.playState.currentTime = currentTime;
  send({ type: 'play-state', action: newAction, currentTime, videoIndex: State.playState.videoIndex });

  // Apply locally
  if (State.content?.type === 'local' && State.localMediaEl) {
    newAction === 'play' ? State.localMediaEl.play().catch(() => {}) : State.localMediaEl.pause();
  } else if (State.ytPlayer && State.ytReady) {
    newAction === 'play' ? State.ytPlayer.playVideo?.() : State.ytPlayer.pauseVideo?.();
  }

  updatePlayButton(newAction === 'play');
}

function updatePlayButton(isPlaying) {
  const btn = document.getElementById('play-btn');
  if (btn) btn.textContent = isPlaying ? '⏸' : '▶';
  const art = document.getElementById('audio-art');
  if (art) art.classList.toggle('playing', isPlaying);
}

function seek(delta) {
  const canControl = State.isHost || State.controlMode === 'shared';
  if (!canControl || !State.content) return;

  let newTime = 0;
  if (State.content.type === 'local' && State.localMediaEl) {
    newTime = Math.max(0, State.localMediaEl.currentTime + delta);
    State.localMediaEl.currentTime = newTime;
  } else if (State.ytPlayer && State.ytReady) {
    newTime = Math.max(0, (State.ytPlayer.getCurrentTime?.() || 0) + delta);
    State.ytPlayer.seekTo?.(newTime, true);
  }

  State.playState.currentTime = newTime;
  send({ type: 'play-state', action: State.playState.action, currentTime: newTime, videoIndex: State.playState.videoIndex });
}

function seekByClick(event, track) {
  const canControl = State.isHost || State.controlMode === 'shared';
  if (!canControl || !State.content) return;

  const rect = track.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  let duration = 0;

  if (State.content.type === 'local' && State.localMediaEl) {
    duration = State.localMediaEl.duration;
  } else if (State.ytPlayer && State.ytReady) {
    duration = State.ytPlayer.getDuration?.() || 0;
  }

  const newTime = ratio * duration;
  seek(newTime - (State.localMediaEl?.currentTime || State.ytPlayer?.getCurrentTime?.() || 0));
}

function skipVideo(dir) {
  if (!State.isHost && State.controlMode !== 'shared') return;
  const maxIdx = State.ytQueue.length - 1;
  const newIdx = Math.max(0, Math.min(maxIdx, (State.playState.videoIndex || 0) + dir));
  State.playState.videoIndex = newIdx;
  State.playState.currentTime = 0;
  send({ type: 'play-state', action: 'play', currentTime: 0, videoIndex: newIdx });

  if (State.ytPlayer && State.ytReady) {
    State.ytPlayer.playVideoAt?.(newIdx);
  }
  // Update now playing title
  const sn = document.querySelector('.song-name');
  if (sn) sn.textContent = State.ytQueue[newIdx]?.title || 'Playlist';
}

// ─── Progress Update Loop ─────────────────────────────────────────────────
function startProgressLoop() {
  clearInterval(State.syncInterval);
  State.syncInterval = setInterval(updateProgress, 900);
}

function updateProgress() {
  let cur = 0, dur = 0;
  if (State.content?.type === 'local' && State.localMediaEl) {
    cur = State.localMediaEl.currentTime;
    dur = State.localMediaEl.duration || 0;
  } else if (State.ytPlayer && State.ytReady) {
    cur = State.ytPlayer.getCurrentTime?.() || 0;
    dur = State.ytPlayer.getDuration?.() || 0;
  }

  const fill = document.getElementById('progress-fill');
  const curEl = document.getElementById('time-current');
  const totEl = document.getElementById('time-total');
  if (fill) fill.style.width = dur ? `${(cur / dur) * 100}%` : '0%';
  if (curEl) curEl.textContent = fmt(cur);
  if (totEl) totEl.textContent = fmt(dur);
}

// ─── Heartbeat (host sends current time to server) ─────────────────────
function startHeartbeat() {
  clearInterval(State.heartbeatInterval);
  State.heartbeatInterval = setInterval(() => {
    if (!State.isHost) return;
    let t = 0;
    if (State.localMediaEl) t = State.localMediaEl.currentTime;
    else if (State.ytPlayer && State.ytReady) t = State.ytPlayer.getCurrentTime?.() || 0;
    send({ type: 'heartbeat', currentTime: t, videoIndex: State.playState.videoIndex || 0 });
  }, 5000);
}

// ══════════════════════════════════════════════════════════════════════════
//  CONTENT SETUP
// ══════════════════════════════════════════════════════════════════════════

// ─── Local File ──────────────────────────────────────────────────────────
function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) uploadFile(file);
}

function handleFileDrop(event) {
  event.preventDefault();
  document.getElementById('upload-zone').classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) uploadFile(file);
}

function uploadFile(file) {
  if (file.size > 200 * 1024 * 1024) { toast('File too large (max 200MB)'); return; }

  const prog = document.getElementById('upload-progress');
  const fill = document.getElementById('up-fill');
  const status = document.getElementById('up-status');
  if (prog) prog.classList.add('visible');

  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      if (fill) fill.style.width = pct + '%';
      if (status) status.textContent = `Uploading… ${pct}%`;
    }
  };

  xhr.onload = () => {
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      closeSheet();
      send({
        type: 'set-content',
        contentType: 'local',
        url: data.streamUrl,
        fileId: data.fileId,
        filename: data.filename,
      });
      // Also apply locally for host
      State.content = { type: 'local', url: data.streamUrl, fileId: data.fileId, filename: data.filename };
      State.playState = { action: 'pause', currentTime: 0, videoIndex: 0 };
      renderPlayerArea();
      renderNowPlaying();
      toast(`✅ ${data.filename} loaded`);
    } else {
      toast('Upload failed. Try again.');
    }
    if (prog) prog.classList.remove('visible');
    if (fill) fill.style.width = '0%';
  };

  xhr.onerror = () => { toast('Upload error'); if (prog) prog.classList.remove('visible'); };
  xhr.send(formData);
}

function setupLocalMedia(content) {
  stopAllMedia();
  const isVideo = /\.(mp4|webm|mov)$/i.test(content.filename || '') || content.url?.includes('mp4');
  const el = document.createElement(isVideo ? 'video' : 'audio');
  el.src = content.url;
  el.preload = 'auto';

  if (isVideo) {
    el.controls = false;
    el.playsInline = true;
    el.style.cssText = 'width:100%;max-height:100%;object-fit:contain;background:#000';
    const wrapper = document.querySelector('.audio-wrapper');
    if (wrapper) {
      wrapper.innerHTML = '';
      const vw = document.createElement('div');
      vw.className = 'video-wrapper';
      vw.appendChild(el);
      wrapper.appendChild(vw);
    }
  }

  State.localMediaEl = el;

  el.addEventListener('ended', () => {
    updatePlayButton(false);
    State.playState.action = 'pause';
  });

  el.addEventListener('canplay', () => {
    if (State.playState.action === 'play') el.play().catch(() => {});
    if (State.playState.currentTime > 0) el.currentTime = State.playState.currentTime;
    renderNowPlaying();
  });

  startProgressLoop();
  startHeartbeat();
}

// ─── YouTube ──────────────────────────────────────────────────────────────
let ytAPIReady = false;

window.onYouTubeIframeAPIReady = () => { ytAPIReady = true; };

function setupYT(queue, startIndex) {
  State.ytQueue = queue;
  State.ytReady = false;

  const trySetup = () => {
    if (!ytAPIReady) { setTimeout(trySetup, 300); return; }
    if (!document.getElementById('yt-player')) return;

    const ids = queue.map(v => v.id);

    if (State.ytPlayer) {
      try { State.ytPlayer.destroy(); } catch {}
    }

    State.ytPlayer = new YT.Player('yt-player', {
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: State.playState.action === 'play' ? 1 : 0,
        playlist: ids.join(','),
        index: startIndex,
        controls: 0,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        enablejsapi: 1,
      },
      videoId: ids[0],
      events: {
        onReady: (e) => {
          State.ytReady = true;
          if (startIndex > 0) e.target.playVideoAt?.(startIndex);
          if (State.playState.currentTime > 2) e.target.seekTo?.(State.playState.currentTime, true);
          if (State.playState.action === 'play') e.target.playVideo?.();
          startProgressLoop();
          startHeartbeat();
        },
        onStateChange: (e) => {
          const YTS = YT.PlayerState;
          if (e.data === YTS.PLAYING) updatePlayButton(true);
          if (e.data === YTS.PAUSED) updatePlayButton(false);
          if (e.data === YTS.ENDED && State.ytQueue.length > 1) {
            const next = (State.playState.videoIndex || 0) + 1;
            if (next < State.ytQueue.length) {
              State.playState.videoIndex = next;
              send({ type: 'play-state', action: 'play', currentTime: 0, videoIndex: next });
              const sn = document.querySelector('.song-name');
              if (sn) sn.textContent = State.ytQueue[next]?.title || 'Playlist';
            }
          }
        },
      },
    });
  };

  trySetup();
}

// ─── Add YouTube Video ─────────────────────────────────────────────────
async function addYouTube() {
  const input = document.getElementById('yt-input');
  const url = input?.value.trim();
  if (!url) { toast('Paste a YouTube URL first'); return; }
  const id = getYTId(url);
  if (!id) { toast('Invalid YouTube URL'); return; }

  LS.pushHistory('youtube', url);
  closeSheet();

  send({
    type: 'set-content',
    contentType: 'youtube',
    url,
    fileId: null,
    filename: null,
  });

  State.content = { type: 'youtube', url };
  State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
  renderPlayerArea();
  renderNowPlaying();
}

// ─── Add Playlist ──────────────────────────────────────────────────────
async function addPlaylist() {
  const input = document.getElementById('pl-input');
  const url = input?.value.trim();
  if (!url) { toast('Paste a YouTube playlist URL'); return; }

  toast('⏳ Loading playlist…', 5000);

  const ids = await getYTPlaylistIds(url);
  if (!ids || !ids.length) {
    toast('❌ Could not load playlist. Make sure it is public.');
    return;
  }

  LS.pushHistory('playlist', url);
  closeSheet();

  send({
    type: 'set-content',
    contentType: 'youtube-playlist',
    url,
    fileId: null,
    filename: null,
    queue: ids,
  });

  // Server's set-content handler doesn't know about queue yet — patch message
  // We send a custom set-content that carries queue
  // (server stores content.queue for late joiners)

  State.content = { type: 'youtube-playlist', url, queue: ids };
  State.ytQueue = ids;
  State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
  renderPlayerArea();
  renderNowPlaying();
  toast(`✅ ${ids.length} videos loaded`);
}

// ══════════════════════════════════════════════════════════════════════════
//  SHEET
// ══════════════════════════════════════════════════════════════════════════
function openSheet() {
  document.getElementById('sheet-backdrop')?.classList.add('open');
  document.getElementById('content-sheet')?.classList.add('open');
  renderSheetHistories();
}

function closeSheet() {
  document.getElementById('sheet-backdrop')?.classList.remove('open');
  document.getElementById('content-sheet')?.classList.remove('open');
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    const tabs = ['local', 'youtube', 'playlist'];
    b.classList.toggle('active', tabs[i] === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tab}`);
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  PWA & INIT
// ══════════════════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Handle pending content after room create
const _origHandleMsg = handleMessage;
function handleMessage(msg) {
  _origHandleMsg(msg);
  if (msg.type === 'room-created' && State._pendingContent) {
    const p = State._pendingContent;
    State._pendingContent = null;
    setTimeout(() => {
      if (p.type === 'yt') {
        State.content = { type: 'youtube', url: p.url };
        State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
        send({ type: 'set-content', contentType: 'youtube', url: p.url });
        renderPlayerArea(); renderNowPlaying();
      } else {
        document.getElementById('pl-input') && (document.getElementById('pl-input').value = p.url);
        addPlaylist();
      }
    }, 400);
  }
}

// Server-side queue support: patch set-content to forward queue
const _origSend = send;
function send(obj) {
  // Forward queue for playlist
  if (obj.type === 'set-content' && obj.contentType === 'youtube-playlist' && State.ytQueue.length) {
    obj.queue = State.ytQueue;
  }
  if (State.ws && State.ws.readyState === WebSocket.OPEN) {
    State.ws.send(JSON.stringify(obj));
  }
}

// Init
connectWS();
renderHome();
 
