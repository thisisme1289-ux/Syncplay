/* ═══════════════════════════════════════════════════════════════════════════
   SyncPlay — app.js  (v3 - fixed WS timing + ping/pong)
═══════════════════════════════════════════════════════════════════════════ */

const State = {
  ws: null,
  wsReady: false,
  msgQueue: [],              // ← queue msgs sent before WS is open
  roomCode: null,
  isHost: false,
  controlMode: 'host',
  content: null,
  playState: { action: 'pause', currentTime: 0, videoIndex: 0 },
  ytPlayer: null,
  ytReady: false,
  ytQueue: [],
  localMediaEl: null,
  heartbeatInterval: null,
  syncInterval: null,
  pingInterval: null,        // ← keep Render connection alive
  username: '',
  reconnectTimer: null,
  pendingContent: null,
};

// ─── Local Storage ────────────────────────────────────────────────────────
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
  try {
    const rss = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${m[1]}`);
    const text = await rss.text();
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const ids = [];
    xml.querySelectorAll('entry').forEach(e => {
      const id = e.querySelector('videoId')?.textContent;
      const title = e.querySelector('title')?.textContent;
      if (id) ids.push({ id, title: title || id });
    });
    return ids.length ? ids : null;
  } catch { return null; }
}

let toastTimer;
function toast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function setStatus(msg) {
  const el = document.getElementById('ws-status');
  if (!el) return;
  if (msg) { el.textContent = msg; el.classList.add('visible'); }
  else { el.classList.remove('visible'); }
}

// ─── Send — queues if WS not ready yet ───────────────────────────────────
function send(obj) {
  if (obj.type === 'set-content' && obj.contentType === 'youtube-playlist' && State.ytQueue.length) {
    obj.queue = State.ytQueue;
  }
  if (State.ws && State.ws.readyState === WebSocket.OPEN) {
    State.ws.send(JSON.stringify(obj));
  } else {
    // Queue it — will be flushed when connection opens
    State.msgQueue.push(obj);
  }
}

function flushQueue() {
  while (State.msgQueue.length) {
    const obj = State.msgQueue.shift();
    if (State.ws && State.ws.readyState === WebSocket.OPEN) {
      State.ws.send(JSON.stringify(obj));
    }
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────
function connectWS() {
  clearInterval(State.pingInterval);
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${protocol}://${location.host}`;
  console.log('[SyncPlay] Connecting to', url);
  setStatus('⚡ Connecting…');

  const ws = new WebSocket(url);
  State.ws = ws;
  State.wsReady = false;

  ws.onopen = () => {
    console.log('[SyncPlay] WebSocket connected');
    State.wsReady = true;
    setStatus(null);
    clearTimeout(State.reconnectTimer);
    flushQueue();   // send anything queued while connecting

    // Ping every 30s to keep Render from closing idle connections
    State.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
  };

  ws.onclose = (e) => {
    console.log('[SyncPlay] WebSocket closed', e.code, e.reason);
    State.wsReady = false;
    clearInterval(State.pingInterval);
    setStatus('⚡ Reconnecting…');
    clearTimeout(State.reconnectTimer);
    State.reconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = (e) => {
    console.error('[SyncPlay] WebSocket error', e);
    ws.close();
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'pong') return; // ignore pongs
    handleMessage(msg);
  };
}

// ─── Message Handler ──────────────────────────────────────────────────────
function handleMessage(msg) {
  console.log('[SyncPlay] msg:', msg.type);
  switch (msg.type) {

    case 'room-created':
      State.roomCode = msg.roomCode;
      State.isHost = true;
      LS.pushHistory('room', msg.roomCode);
      renderRoom();
      if (State.pendingContent) {
        const p = State.pendingContent;
        State.pendingContent = null;
        setTimeout(() => {
          if (p.type === 'yt') {
            State.content = { type: 'youtube', url: p.url };
            State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
            send({ type: 'set-content', contentType: 'youtube', url: p.url });
            renderPlayerArea(); renderNowPlaying();
          } else {
            addPlaylistFromUrl(p.url);
          }
        }, 400);
      }
      break;

    case 'room-joined':
      State.roomCode = msg.roomCode;
      State.isHost = false;
      State.controlMode = msg.controlMode;
      if (msg.content) applyContent(msg.content, msg.playState);
      LS.pushHistory('room', msg.roomCode);
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
      State.roomCode = null; State.isHost = false; State.content = null;
      renderHome();
      break;

    case 'error':
      toast(`❌ ${msg.message}`);
      break;
  }
}

function applyContent(content, playState) {
  State.content = content;
  State.playState = playState || { action: 'pause', currentTime: 0, videoIndex: 0 };
  if (content?.type === 'youtube-playlist') State.ytQueue = content.queue || [];
  stopAllMedia();
}

function applyPlayState(ps) {
  State.playState = ps;

  if (State.content?.type === 'local' && State.localMediaEl) {
    const el = State.localMediaEl;
    const drift = Math.abs(el.currentTime - ps.currentTime);

    if (drift > 2) {
      // Pause first, seek, then resume — prevents audio buffer corruption
      el.pause();
      el.currentTime = ps.currentTime;
      if (ps.action === 'play') {
        const onSeeked = () => {
          el.removeEventListener('seeked', onSeeked);
          el.play().catch(() => {});
        };
        el.addEventListener('seeked', onSeeked);
      }
    } else {
      ps.action === 'play' ? el.play().catch(() => {}) : el.pause();
    }
    updatePlayButton(ps.action === 'play');

  } else if (State.ytPlayer && State.ytReady) {
    if (State.content?.type === 'youtube-playlist') {
      if (State.ytPlayer.getPlaylistIndex?.() !== (ps.videoIndex || 0))
        State.ytPlayer.playVideoAt?.(ps.videoIndex || 0);
    }
    if (Math.abs((State.ytPlayer.getCurrentTime?.() || 0) - ps.currentTime) > 2.5)
      State.ytPlayer.seekTo?.(ps.currentTime, true);
    ps.action === 'play' ? State.ytPlayer.playVideo?.() : State.ytPlayer.pauseVideo?.();
    updatePlayButton(ps.action === 'play');
  }
}

function stopAllMedia() {
  if (State.localMediaEl) {
    State.localMediaEl.pause();
    State.localMediaEl.src = '';
    State.localMediaEl = null;
  }
  if (State.ytPlayer && State.ytReady) { try { State.ytPlayer.stopVideo?.(); } catch {} }
  clearInterval(State.heartbeatInterval);
  clearInterval(State.syncInterval);
}

// ══════════════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════════════

function renderHome() {
  const ytH = LS.getHistory('youtube');
  const plH = LS.getHistory('playlist');
  const roomH = LS.getHistory('room');

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
            <input type="text" id="room-code-input" placeholder="ABC123" maxlength="6"
              autocomplete="off" onkeydown="if(event.key==='Enter') joinRoom()" />
            <button class="btn btn-outline" onclick="joinRoom()">Join</button>
          </div>
        </div>

        ${roomH.length ? `
          <div class="home-history">
            <div class="section-title">Recent rooms</div>
            <div>${roomH.map(c => `
              <span class="history-chip"
                onclick="document.getElementById('room-code-input').value='${c}';joinRoom()">
                <span class="chip-icon">🚪</span>${c}
              </span>`).join('')}
            </div>
          </div>` : ''}

        ${ytH.length || plH.length ? `
          <div class="home-history">
            <div class="section-title">Saved links</div>
            <div>
              ${ytH.map(u => `<span class="history-chip" title="${u}"
                onclick="prefillAndCreate('yt','${encodeURIComponent(u)}')">
                <span class="chip-icon">▶</span>${u}</span>`).join('')}
              ${plH.map(u => `<span class="history-chip" title="${u}"
                onclick="prefillAndCreate('pl','${encodeURIComponent(u)}')">
                <span class="chip-icon">📋</span>${u}</span>`).join('')}
            </div>
          </div>` : ''}
      </div>
    </div>
    <div id="toast" class="toast"></div>
    <div id="ws-status" class="ws-status">⚡ Connecting…</div>
  `;

  // Reflect current connection state
  if (!State.wsReady) setStatus('⚡ Connecting…');
  else setStatus(null);
}

function renderRoom() {
  const canControl = State.isHost || State.controlMode === 'shared';
  document.getElementById('app').innerHTML = `
    <div class="room-screen">
      <div class="room-header">
        <div class="room-info">
          <div>
            <div class="room-label">ROOM</div>
            <div class="room-code-text" onclick="copyCode()" title="Tap to copy">${State.roomCode}</div>
          </div>
        </div>
        <div class="room-right">
          ${State.isHost ? `
            <button class="ctrl-toggle ${State.controlMode==='shared'?'shared':''}"
              id="ctrl-toggle-btn" onclick="toggleControlMode()">
              ${State.controlMode==='shared'?'🔓 Shared':'🔒 Host only'}
            </button>` : ''}
          <button class="icon-btn danger" onclick="leaveRoom()">✕</button>
        </div>
      </div>

      <div class="player-area" id="player-area">${renderEmptyPlayer()}</div>
      <div class="now-playing" id="now-playing"></div>

      <div class="controls ${canControl?'':'locked'}" id="controls">
        <button class="ctrl-btn" onclick="seek(-10)">⏮</button>
        <button class="ctrl-btn play-main" id="play-btn" onclick="togglePlay()">▶</button>
        <button class="ctrl-btn" onclick="seek(10)">⏭</button>
        ${State.content?.type==='youtube-playlist'?`
          <button class="ctrl-btn" onclick="skipVideo(1)">⏩</button>`:''}
      </div>

      ${State.isHost ? `
        <div class="bottom-bar">
          <button class="btn btn-outline full-width" onclick="openSheet()">＋ Add Content</button>
        </div>` : `
        <div class="guest-bar">
          <p>🎧 Guest — ${State.controlMode==='shared'?'you can control':'host controls'}</p>
        </div>`}
    </div>

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
      <div class="tab-panel active" id="tab-local">
        <div class="upload-zone" id="upload-zone"
          onclick="document.getElementById('file-input').click()"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="handleFileDrop(event)">
          <div class="uz-icon">🎵</div>
          <p>Tap to pick MP3 or MP4</p>
          <p class="hint">Max 200MB • streams to everyone</p>
        </div>
        <input type="file" id="file-input" accept="audio/*,video/*,.mp3,.mp4,.m4a,.webm,.ogg"
          style="display:none" onchange="handleFileSelect(event)" />
        <div class="upload-progress" id="upload-progress">
          <div class="up-bar"><div class="up-fill" id="up-fill"></div></div>
          <div class="up-status" id="up-status">Uploading…</div>
        </div>
      </div>
      <div class="tab-panel" id="tab-youtube">
        <div class="url-row">
          <input type="url" id="yt-input" placeholder="https://youtube.com/watch?v=…" />
          <button class="btn btn-primary" onclick="addYouTube()">Play</button>
        </div>
        <div id="yt-history"></div>
      </div>
      <div class="tab-panel" id="tab-playlist">
        <div class="url-row">
          <input type="url" id="pl-input" placeholder="https://youtube.com/playlist?list=…" />
          <button class="btn btn-primary" onclick="addPlaylist()">Load</button>
        </div>
        <div id="pl-history"></div>
      </div>
    </div>

    <div id="toast" class="toast"></div>
    <div id="ws-status" class="ws-status"></div>
  `;

  renderPlayerArea();
  renderNowPlaying();
  updateControlLock();
  renderSheetHistories();
}

function renderEmptyPlayer() {
  return `<div class="empty-player">
    <div class="empty-icon">🎵</div>
    <p>${State.isHost ? 'Tap "Add Content" below to start' : 'Waiting for host to add music…'}</p>
    <p class="hint">Share code <strong>${State.roomCode}</strong> with friends</p>
  </div>`;
}

function renderPlayerArea() {
  const area = document.getElementById('player-area');
  if (!area) return;
  if (!State.content) { area.innerHTML = renderEmptyPlayer(); return; }
  const c = State.content;
  if (c.type === 'local') {
    area.innerHTML = `<div class="audio-wrapper"><div class="audio-art" id="audio-art">🎵</div></div>`;
    setupLocalMedia(c);
  } else if (c.type === 'youtube') {
    area.innerHTML = `<div class="yt-wrapper"><div id="yt-player"></div></div>`;
    setupYT([{ id: getYTId(c.url), title: 'Video' }], 0);
  } else if (c.type === 'youtube-playlist') {
    area.innerHTML = `<div class="yt-wrapper"><div id="yt-player"></div></div>`;
    setupYT(State.ytQueue, State.playState.videoIndex || 0);
  }
}

function renderNowPlaying() {
  const el = document.getElementById('now-playing');
  if (!el || !State.content) return;
  const c = State.content;
  let badge = '', name = '';
  if (c.type === 'local') { badge = 'LOCAL'; name = c.filename || 'Local file'; }
  else if (c.type === 'youtube') { badge = 'YOUTUBE'; name = c.url; }
  else if (c.type === 'youtube-playlist') {
    badge = 'PLAYLIST';
    name = State.ytQueue[State.playState.videoIndex || 0]?.title || 'Playlist';
  }
  el.innerHTML = `
    <div class="now-playing-info">
      <span class="content-badge">${badge}</span>
      <span class="song-name">${name}</span>
    </div>
    <div class="progress-track" onclick="seekByClick(event,this)" id="progress-track">
      <div class="progress-fill" id="progress-fill"></div>
    </div>
    <div class="time-row">
      <span id="time-current">0:00</span>
      <span id="time-total">0:00</span>
    </div>`;
}

function renderSheetHistories() {
  const ytH = LS.getHistory('youtube');
  const plH = LS.getHistory('playlist');
  const ytEl = document.getElementById('yt-history');
  const plEl = document.getElementById('pl-history');
  if (ytEl && ytH.length)
    ytEl.innerHTML = `<div class="sh-label mt-8">Recent</div>` +
      ytH.map(u => `<div class="sh-item"
        onclick="document.getElementById('yt-input').value='${u}';addYouTube()">
        <span class="sh-item-icon">▶</span><span class="sh-item-url">${u}</span></div>`).join('');
  if (plEl && plH.length)
    plEl.innerHTML = `<div class="sh-label mt-8">Recent</div>` +
      plH.map(u => `<div class="sh-item"
        onclick="document.getElementById('pl-input').value='${u}';addPlaylist()">
        <span class="sh-item-icon">📋</span><span class="sh-item-url">${u}</span></div>`).join('');
}

// ══════════════════════════════════════════════════════════════════════════
//  ACTIONS
// ══════════════════════════════════════════════════════════════════════════

function getUsername() {
  const el = document.getElementById('username-input');
  const name = (el?.value.trim() || LS.get('username') || '').substring(0, 20);
  if (name) { LS.set('username', name); State.username = name; }
  return name;
}

function createRoom() {
  const name = getUsername();
  if (!name) { toast('Enter your name first'); return; }
  // Show feedback immediately so user knows something is happening
  const btn = document.getElementById('create-btn');
  if (btn) { btn.textContent = '⏳ Creating…'; btn.disabled = true; }
  send({ type: 'create-room', username: name });
}

function joinRoom() {
  const name = getUsername();
  if (!name) { toast('Enter your name first'); return; }
  const code = (document.getElementById('room-code-input')?.value || '').trim().toUpperCase();
  if (code.length < 4) { toast('Enter a valid room code'); return; }
  send({ type: 'join-room', roomCode: code, username: name });
}

function prefillAndCreate(type, encodedUrl) {
  State.pendingContent = { type, url: decodeURIComponent(encodedUrl) };
  const name = LS.get('username') || 'Host';
  State.username = name;
  send({ type: 'create-room', username: name });
}

function leaveRoom() {
  stopAllMedia();
  State.roomCode = null; State.content = null;
  State.isHost = false; State.ytQueue = [];
  if (State.ws) State.ws.close();
  setTimeout(connectWS, 300);
  renderHome();
}

function copyCode() {
  navigator.clipboard?.writeText(State.roomCode)
    .then(() => toast('📋 Code copied!'))
    .catch(() => toast(`Code: ${State.roomCode}`));
}

function toggleControlMode() {
  if (!State.isHost) return;
  send({ type: 'toggle-control', mode: State.controlMode === 'shared' ? 'host' : 'shared' });
}

function updateControlLock() {
  const canControl = State.isHost || State.controlMode === 'shared';
  document.getElementById('controls')?.classList.toggle('locked', !canControl);
  const tb = document.getElementById('ctrl-toggle-btn');
  if (tb) {
    tb.textContent = State.controlMode === 'shared' ? '🔓 Shared' : '🔒 Host only';
    tb.classList.toggle('shared', State.controlMode === 'shared');
  }
  const gb = document.querySelector('.guest-bar p');
  if (gb) gb.textContent = `🎧 Guest — ${State.controlMode === 'shared' ? 'you can control' : 'host controls'}`;
}

function togglePlay() {
  if (!State.isHost && State.controlMode !== 'shared') return;
  if (!State.content) return;
  const newAction = State.playState.action === 'play' ? 'pause' : 'play';
  let currentTime = State.localMediaEl?.currentTime || State.ytPlayer?.getCurrentTime?.() || 0;
  State.playState.action = newAction;
  State.playState.currentTime = currentTime;
  send({ type: 'play-state', action: newAction, currentTime, videoIndex: State.playState.videoIndex || 0 });
  if (State.content.type === 'local' && State.localMediaEl) {
    newAction === 'play' ? State.localMediaEl.play().catch(() => {}) : State.localMediaEl.pause();
  } else if (State.ytPlayer && State.ytReady) {
    newAction === 'play' ? State.ytPlayer.playVideo?.() : State.ytPlayer.pauseVideo?.();
  }
  updatePlayButton(newAction === 'play');
}

function updatePlayButton(isPlaying) {
  const btn = document.getElementById('play-btn');
  if (btn) btn.textContent = isPlaying ? '⏸' : '▶';
  document.getElementById('audio-art')?.classList.toggle('playing', isPlaying);
}

function seek(delta) {
  if (!State.isHost && State.controlMode !== 'shared') return;
  if (!State.content) return;

  let newTime = 0;

  if (State.content.type === 'local' && State.localMediaEl) {
    const el = State.localMediaEl;
    const wasPlaying = State.playState.action === 'play';
    newTime = Math.max(0, el.currentTime + delta);

    // Pause → seek → resume to prevent audio distortion
    el.pause();
    el.currentTime = newTime;

    if (wasPlaying) {
      const onSeeked = () => {
        el.removeEventListener('seeked', onSeeked);
        el.play().catch(() => {});
      };
      el.addEventListener('seeked', onSeeked);
    }

  } else if (State.ytPlayer && State.ytReady) {
    newTime = Math.max(0, (State.ytPlayer.getCurrentTime?.() || 0) + delta);
    State.ytPlayer.seekTo?.(newTime, true);
  }

  State.playState.currentTime = newTime;
  send({ type: 'play-state', action: State.playState.action, currentTime: newTime, videoIndex: State.playState.videoIndex || 0 });
}

function seekByClick(event, track) {
  if (!State.isHost && State.controlMode !== 'shared') return;
  if (!State.content) return;
  const ratio = (event.clientX - track.getBoundingClientRect().left) / track.offsetWidth;
  const dur = State.localMediaEl?.duration || State.ytPlayer?.getDuration?.() || 0;
  const cur = State.localMediaEl?.currentTime || State.ytPlayer?.getCurrentTime?.() || 0;
  seek(ratio * dur - cur);
}

function skipVideo(dir) {
  if (!State.isHost && State.controlMode !== 'shared') return;
  const newIdx = Math.max(0, Math.min(State.ytQueue.length - 1, (State.playState.videoIndex || 0) + dir));
  State.playState.videoIndex = newIdx;
  send({ type: 'play-state', action: 'play', currentTime: 0, videoIndex: newIdx });
  State.ytPlayer?.playVideoAt?.(newIdx);
  const sn = document.querySelector('.song-name');
  if (sn) sn.textContent = State.ytQueue[newIdx]?.title || 'Playlist';
}

function startProgressLoop() {
  clearInterval(State.syncInterval);
  State.syncInterval = setInterval(() => {
    let cur = 0, dur = 0;
    if (State.content?.type === 'local' && State.localMediaEl) {
      cur = State.localMediaEl.currentTime; dur = State.localMediaEl.duration || 0;
    } else if (State.ytPlayer && State.ytReady) {
      cur = State.ytPlayer.getCurrentTime?.() || 0; dur = State.ytPlayer.getDuration?.() || 0;
    }
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = dur ? `${(cur/dur)*100}%` : '0%';
    const ce = document.getElementById('time-current');
    const te = document.getElementById('time-total');
    if (ce) ce.textContent = fmt(cur);
    if (te) te.textContent = fmt(dur);
  }, 900);
}

function startHeartbeat() {
  clearInterval(State.heartbeatInterval);
  State.heartbeatInterval = setInterval(() => {
    if (!State.isHost) return;
    const t = State.localMediaEl?.currentTime || State.ytPlayer?.getCurrentTime?.() || 0;
    send({ type: 'heartbeat', currentTime: t, videoIndex: State.playState.videoIndex || 0 });
  }, 5000);
}

// ══════════════════════════════════════════════════════════════════════════
//  CONTENT SETUP
// ══════════════════════════════════════════════════════════════════════════

function handleFileSelect(e) { if (e.target.files[0]) uploadFile(e.target.files[0]); }
function handleFileDrop(e) {
  e.preventDefault();
  document.getElementById('upload-zone')?.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
}

function uploadFile(file) {
  if (file.size > 200 * 1024 * 1024) { toast('File too large (max 200MB)'); return; }
  const prog = document.getElementById('upload-progress');
  const fill = document.getElementById('up-fill');
  const status = document.getElementById('up-status');
  if (prog) prog.classList.add('visible');

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round(e.loaded / e.total * 100);
      if (fill) fill.style.width = pct + '%';
      if (status) status.textContent = `Uploading… ${pct}%`;
    }
  };
  xhr.onload = () => {
    if (prog) { prog.classList.remove('visible'); }
    if (fill) fill.style.width = '0%';
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      closeSheet();
      send({ type: 'set-content', contentType: 'local', url: data.streamUrl, fileId: data.fileId, filename: data.filename });
      State.content = { type: 'local', url: data.streamUrl, fileId: data.fileId, filename: data.filename };
      State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
      renderPlayerArea(); renderNowPlaying();
      toast(`✅ ${data.filename} loaded`);
    } else { toast('Upload failed'); }
  };
  xhr.onerror = () => { toast('Upload error'); if (prog) prog.classList.remove('visible'); };
  const fd = new FormData();
  fd.append('file', file);
  xhr.send(fd);
}

function setupLocalMedia(content) {
  stopAllMedia();
  const isVideo = /\.(mp4|webm|mov)$/i.test(content.filename || '');
  const el = document.createElement(isVideo ? 'video' : 'audio');
  el.src = content.url; el.preload = 'auto'; el.playsInline = true;
  State.localMediaEl = el;
  if (isVideo) {
    el.style.cssText = 'width:100%;max-height:100%;object-fit:contain;background:#000';
    const wrapper = document.querySelector('.audio-wrapper');
    if (wrapper) { wrapper.innerHTML = ''; const vw = document.createElement('div'); vw.className = 'video-wrapper'; vw.appendChild(el); wrapper.appendChild(vw); }
  }
  el.addEventListener('ended', () => { updatePlayButton(false); State.playState.action = 'pause'; });
  el.addEventListener('canplay', () => {
    if (State.playState.currentTime > 0) el.currentTime = State.playState.currentTime;
    if (State.playState.action === 'play') el.play().catch(() => {});
    renderNowPlaying();
  });
  startProgressLoop(); startHeartbeat();
}

let ytAPIReady = false;
window.onYouTubeIframeAPIReady = () => { ytAPIReady = true; };

function setupYT(queue, startIndex) {
  if (!queue?.length) return;
  State.ytQueue = queue; State.ytReady = false;
  const trySetup = () => {
    if (!ytAPIReady) { setTimeout(trySetup, 300); return; }
    if (!document.getElementById('yt-player')) return;
    if (State.ytPlayer) { try { State.ytPlayer.destroy(); } catch {} }
    const ids = queue.map(v => v.id);
    State.ytPlayer = new YT.Player('yt-player', {
      width: '100%', height: '100%', videoId: ids[0],
      playerVars: { autoplay: 0, playlist: ids.join(','), index: startIndex, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, enablejsapi: 1 },
      events: {
        onReady: (e) => {
          State.ytReady = true;
          if (startIndex > 0) e.target.playVideoAt?.(startIndex);
          if (State.playState.currentTime > 2) e.target.seekTo?.(State.playState.currentTime, true);
          if (State.playState.action === 'play') e.target.playVideo?.();
          startProgressLoop(); startHeartbeat();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) updatePlayButton(true);
          if (e.data === YT.PlayerState.PAUSED) updatePlayButton(false);
          if (e.data === YT.PlayerState.ENDED && State.ytQueue.length > 1) {
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

async function addYouTube() {
  const url = document.getElementById('yt-input')?.value.trim();
  if (!url) { toast('Paste a YouTube URL first'); return; }
  if (!getYTId(url)) { toast('Invalid YouTube URL'); return; }
  LS.pushHistory('youtube', url);
  closeSheet();
  send({ type: 'set-content', contentType: 'youtube', url });
  State.content = { type: 'youtube', url };
  State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
  renderPlayerArea(); renderNowPlaying();
}

async function addPlaylist() {
  const url = document.getElementById('pl-input')?.value.trim();
  if (!url) { toast('Paste a YouTube playlist URL'); return; }
  await addPlaylistFromUrl(url);
}

async function addPlaylistFromUrl(url) {
  toast('⏳ Loading playlist…', 5000);
  const ids = await getYTPlaylistIds(url);
  if (!ids?.length) { toast('❌ Could not load playlist. Make sure it is Public.'); return; }
  LS.pushHistory('playlist', url);
  closeSheet();
  State.ytQueue = ids;
  send({ type: 'set-content', contentType: 'youtube-playlist', url });
  State.content = { type: 'youtube-playlist', url, queue: ids };
  State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
  renderPlayerArea(); renderNowPlaying();
  toast(`✅ ${ids.length} videos loaded`);
}

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
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('active', ['local','youtube','playlist'][i]===tab));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id===`tab-${tab}`));
}

// ─── PWA & Init ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

connectWS();
renderHome();
