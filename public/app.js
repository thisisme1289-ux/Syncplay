/* ═══════════════════════════════════════════════════════════════════════════
   SyncPlay — app.js  v4
   Fixes: blob-based local audio (no seek distortion), YouTube audio proxy
   (background playback), removed room history, playlist error handling
═══════════════════════════════════════════════════════════════════════════ */

const State = {
  ws: null,
  wsReady: false,
  msgQueue: [],
  roomCode: null,
  isHost: false,
  controlMode: 'host',
  content: null,
  playState: { action: 'pause', currentTime: 0, videoIndex: 0 },
  // Local file: played via <audio> with a blob: URL (fully in memory)
  localMediaEl: null,
  localBlobUrl: null,
  // YouTube audio: played via <audio> through our server proxy
  ytAudioEl: null,
  // YouTube video iframe (fallback when audio proxy not used)
  ytPlayer: null,
  ytReady: false,
  ytQueue: [],
  heartbeatInterval: null,
  syncInterval: null,
  pingInterval: null,
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
    if (!rss.ok) throw new Error('RSS fetch failed');
    const text = await rss.text();
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const ids = [];
    xml.querySelectorAll('entry').forEach(e => {
      const id = e.querySelector('videoId')?.textContent;
      const title = e.querySelector('title')?.textContent;
      if (id) ids.push({ id, title: title || id });
    });
    return ids.length ? ids : null;
  } catch(err) {
    console.error('[Playlist]', err);
    return null;
  }
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

// ─── Send ─────────────────────────────────────────────────────────────────
function send(obj) {
  if (obj.type === 'set-content' && obj.contentType === 'youtube-playlist' && State.ytQueue.length) {
    obj.queue = State.ytQueue;
  }
  if (State.ws && State.ws.readyState === WebSocket.OPEN) {
    State.ws.send(JSON.stringify(obj));
  } else {
    State.msgQueue.push(obj);
  }
}
function flushQueue() {
  while (State.msgQueue.length) {
    const obj = State.msgQueue.shift();
    if (State.ws?.readyState === WebSocket.OPEN) State.ws.send(JSON.stringify(obj));
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────
function connectWS() {
  clearInterval(State.pingInterval);
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  setStatus('⚡ Connecting…');
  const ws = new WebSocket(`${protocol}://${location.host}`);
  State.ws = ws;
  State.wsReady = false;

  ws.onopen = () => {
    State.wsReady = true;
    setStatus(null);
    clearTimeout(State.reconnectTimer);
    flushQueue();
    State.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
  };
  ws.onclose = () => {
    State.wsReady = false;
    clearInterval(State.pingInterval);
    setStatus('⚡ Reconnecting…');
    clearTimeout(State.reconnectTimer);
    State.reconnectTimer = setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'pong') return;
    handleMessage(msg);
  };
}

// ─── Messages ─────────────────────────────────────────────────────────────
function handleMessage(msg) {
  console.log('[WS]', msg.type);
  switch (msg.type) {

    case 'room-created':
      State.roomCode = msg.roomCode;
      State.isHost = true;
      // NOTE: No room history saved — room codes expire when room ends
      renderRoom();
      if (State.pendingContent) {
        const p = State.pendingContent; State.pendingContent = null;
        setTimeout(() => {
          if (p.type === 'yt') applyYouTubeUrl(p.url);
          else addPlaylistFromUrl(p.url);
        }, 400);
      }
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
      toast(`▶ ${msg.content?.title || msg.content?.filename || 'Content loaded'}`);
      break;

    case 'play-state':
      applyPlayState(msg);
      break;

    case 'control-mode':
      State.controlMode = msg.mode;
      updateControlLock();
      toast(msg.mode === 'shared' ? '🔓 Anyone can control' : '🔒 Host controls only');
      break;

    case 'user-joined': toast(`👋 ${msg.username} joined`); break;
    case 'user-left': toast(`${msg.username} left`); break;

    case 'host-left':
      toast('Host left the room', 4000);
      stopAllMedia();
      State.roomCode = null; State.isHost = false; State.content = null;
      renderHome();
      break;

    case 'error': toast(`❌ ${msg.message}`); break;
  }
}

// ─── Apply Content ────────────────────────────────────────────────────────
function applyContent(content, playState) {
  stopAllMedia();
  State.content = content;
  State.playState = playState || { action: 'pause', currentTime: 0, videoIndex: 0 };
  if (content?.type === 'youtube-playlist') State.ytQueue = content.queue || [];
}

// ─── Apply Play State ─────────────────────────────────────────────────────
function applyPlayState(ps) {
  State.playState = ps;

  // ── Local file (blob in memory — seek is instant, never network) ─────
  if (State.content?.type === 'local' && State.localMediaEl) {
    const el = State.localMediaEl;
    const drift = Math.abs(el.currentTime - ps.currentTime);
    if (drift > 1.5) {
      // Clean pause → seek → resume
      el.pause();
      el.currentTime = ps.currentTime;
      if (ps.action === 'play') {
        el.addEventListener('seeked', function handler() {
          el.removeEventListener('seeked', handler);
          el.play().catch(() => {});
        });
      }
    } else {
      ps.action === 'play' ? el.play().catch(() => {}) : el.pause();
    }
    updatePlayButton(ps.action === 'play');

  // ── YouTube audio via proxy (background-capable <audio>) ─────────────
  } else if (State.content?.type === 'youtube' && State.ytAudioEl) {
    const el = State.ytAudioEl;
    const drift = Math.abs(el.currentTime - ps.currentTime);
    if (drift > 2) {
      el.pause();
      el.currentTime = ps.currentTime;
      if (ps.action === 'play') {
        el.addEventListener('seeked', function handler() {
          el.removeEventListener('seeked', handler);
          el.play().catch(() => {});
        });
      }
    } else {
      ps.action === 'play' ? el.play().catch(() => {}) : el.pause();
    }
    updatePlayButton(ps.action === 'play');

  // ── YouTube playlist via proxy ────────────────────────────────────────
  } else if (State.content?.type === 'youtube-playlist' && State.ytAudioEl) {
    const el = State.ytAudioEl;
    // If video index changed, load the new video's audio
    if ((ps.videoIndex || 0) !== State.currentYtIdx) {
      loadYtAudioTrack(ps.videoIndex || 0, ps.currentTime, ps.action === 'play');
    } else {
      const drift = Math.abs(el.currentTime - ps.currentTime);
      if (drift > 2) {
        el.pause();
        el.currentTime = ps.currentTime;
        if (ps.action === 'play') {
          el.addEventListener('seeked', function handler() {
            el.removeEventListener('seeked', handler);
            el.play().catch(() => {});
          });
        }
      } else {
        ps.action === 'play' ? el.play().catch(() => {}) : el.pause();
      }
    }
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
  if (State.localBlobUrl) {
    URL.revokeObjectURL(State.localBlobUrl);
    State.localBlobUrl = null;
  }
  if (State.ytAudioEl) {
    State.ytAudioEl.pause();
    State.ytAudioEl.src = '';
    State.ytAudioEl = null;
  }
  if (State.ytPlayer && State.ytReady) {
    try { State.ytPlayer.stopVideo?.(); } catch {}
  }
  clearInterval(State.heartbeatInterval);
  clearInterval(State.syncInterval);
  State.currentYtIdx = 0;
}

// ══════════════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════════════

function renderHome() {
  const ytH = LS.getHistory('youtube');
  const plH = LS.getHistory('playlist');
  // NOTE: No room history shown — codes expire when room ends (by design)

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
  if (!State.wsReady) setStatus('⚡ Connecting…'); else setStatus(null);
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
        <button class="ctrl-btn" onclick="seek(-10)" title="−10s">⏮</button>
        <button class="ctrl-btn play-main" id="play-btn" onclick="togglePlay()">▶</button>
        <button class="ctrl-btn" onclick="seek(10)" title="+10s">⏭</button>
        ${State.content?.type==='youtube-playlist'?`
          <button class="ctrl-btn" onclick="skipVideo(1)" title="Next">⏩</button>`:''}
      </div>

      ${State.isHost ? `
        <div class="bottom-bar">
          <button class="btn btn-outline full-width" onclick="openSheet()">＋ Add Content</button>
        </div>` : `
        <div class="guest-bar">
          <p>🎧 Guest — ${State.controlMode==='shared'?'you can control':'host controls'}</p>
        </div>`}
    </div>

    <!-- Bottom Sheet -->
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
        <p class="hint mt-8" style="color:var(--text-dim);font-size:12px">
          🎵 Plays audio in background — no video needed
        </p>
        <div id="yt-history"></div>
      </div>

      <div class="tab-panel" id="tab-playlist">
        <div class="url-row">
          <input type="url" id="pl-input" placeholder="https://youtube.com/playlist?list=…" />
          <button class="btn btn-primary" onclick="addPlaylist()">Load</button>
        </div>
        <p class="hint mt-8" style="color:var(--text-dim);font-size:12px">
          📋 Playlist must be Public on YouTube
        </p>
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
    const isVideo = /\.(mp4|webm|mov)$/i.test(c.filename || '');
    if (isVideo) {
      area.innerHTML = `<div class="video-wrapper"><video id="local-video" playsInline style="width:100%;max-height:100%;object-fit:contain;background:#000"></video></div>`;
    } else {
      area.innerHTML = `<div class="audio-wrapper"><div class="audio-art" id="audio-art">🎵</div></div>`;
    }
    setupLocalMedia(c, isVideo);

  } else if (c.type === 'youtube' || c.type === 'youtube-playlist') {
    // Audio-only player — works in background on mobile
    area.innerHTML = `
      <div class="audio-wrapper">
        <div class="audio-art" id="audio-art">▶</div>
      </div>`;
    if (c.type === 'youtube') {
      setupYtAudio(c.url, 0, State.playState.action === 'play');
    } else {
      loadYtAudioTrack(State.playState.videoIndex || 0, State.playState.currentTime, State.playState.action === 'play');
    }
  }
}

function renderNowPlaying() {
  const el = document.getElementById('now-playing');
  if (!el || !State.content) return;
  const c = State.content;
  let badge = '', name = '';
  if (c.type === 'local') { badge = 'LOCAL'; name = c.filename || 'Local file'; }
  else if (c.type === 'youtube') { badge = 'YOUTUBE'; name = c.title || c.url; }
  else if (c.type === 'youtube-playlist') {
    badge = 'PLAYLIST';
    name = State.ytQueue[State.playState.videoIndex || 0]?.title || 'Playlist';
  }
  el.innerHTML = `
    <div class="now-playing-info">
      <span class="content-badge">${badge}</span>
      <span class="song-name" id="song-name">${name}</span>
    </div>
    <div class="progress-track" onclick="seekByClick(event,this)">
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
  State.roomCode = null; State.content = null; State.isHost = false; State.ytQueue = [];
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
  const can = State.isHost || State.controlMode === 'shared';
  document.getElementById('controls')?.classList.toggle('locked', !can);
  const tb = document.getElementById('ctrl-toggle-btn');
  if (tb) { tb.textContent = State.controlMode==='shared'?'🔓 Shared':'🔒 Host only'; tb.classList.toggle('shared', State.controlMode==='shared'); }
  const gb = document.querySelector('.guest-bar p');
  if (gb) gb.textContent = `🎧 Guest — ${State.controlMode==='shared'?'you can control':'host controls'}`;
}

// ─── Playback ─────────────────────────────────────────────────────────────
function getActiveEl() {
  return State.localMediaEl || State.ytAudioEl || null;
}

function togglePlay() {
  if (!State.isHost && State.controlMode !== 'shared') return;
  if (!State.content) return;
  const el = getActiveEl();
  const isPlaying = el ? !el.paused : State.playState.action === 'play';
  const newAction = isPlaying ? 'pause' : 'play';
  const currentTime = el?.currentTime || 0;
  State.playState.action = newAction;
  State.playState.currentTime = currentTime;
  send({ type: 'play-state', action: newAction, currentTime, videoIndex: State.playState.videoIndex || 0 });
  if (el) newAction === 'play' ? el.play().catch(() => {}) : el.pause();
  updatePlayButton(newAction === 'play');
}

function updatePlayButton(isPlaying) {
  const btn = document.getElementById('play-btn');
  if (btn) btn.textContent = isPlaying ? '⏸' : '▶';
  document.getElementById('audio-art')?.classList.toggle('playing', isPlaying);
}

function seek(delta) {
  if (!State.isHost && State.controlMode !== 'shared') return;
  const el = getActiveEl();
  if (!el) return;

  const wasPlaying = !el.paused;
  const newTime = Math.max(0, el.currentTime + delta);

  // Always: pause → set position → wait for seeked → resume
  // This is the ONLY safe way to seek without audio distortion
  el.pause();
  el.currentTime = newTime;

  if (wasPlaying) {
    el.addEventListener('seeked', function handler() {
      el.removeEventListener('seeked', handler);
      el.play().catch(() => {});
    });
  }

  State.playState.currentTime = newTime;
  send({ type: 'play-state', action: State.playState.action, currentTime: newTime, videoIndex: State.playState.videoIndex || 0 });
}

function seekByClick(event, track) {
  if (!State.isHost && State.controlMode !== 'shared') return;
  const el = getActiveEl();
  if (!el) return;
  const ratio = (event.clientX - track.getBoundingClientRect().left) / track.offsetWidth;
  const dur = el.duration || 0;
  if (!dur) return;
  const cur = el.currentTime;
  seek(ratio * dur - cur);
}

function skipVideo(dir) {
  if (!State.isHost && State.controlMode !== 'shared') return;
  const newIdx = Math.max(0, Math.min(State.ytQueue.length - 1, (State.playState.videoIndex || 0) + dir));
  State.playState.videoIndex = newIdx;
  send({ type: 'play-state', action: 'play', currentTime: 0, videoIndex: newIdx });
  loadYtAudioTrack(newIdx, 0, true);
}

function startProgressLoop() {
  clearInterval(State.syncInterval);
  State.syncInterval = setInterval(() => {
    const el = getActiveEl();
    let cur = el?.currentTime || 0;
    let dur = el?.duration || 0;
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
    const el = getActiveEl();
    const t = el?.currentTime || 0;
    send({ type: 'heartbeat', currentTime: t, videoIndex: State.playState.videoIndex || 0 });
  }, 5000);
}

// ══════════════════════════════════════════════════════════════════════════
//  LOCAL FILE — Blob-based (the key to distortion-free seeking)
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
    if (prog) prog.classList.remove('visible');
    if (fill) fill.style.width = '0%';
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      closeSheet();
      send({ type: 'set-content', contentType: 'local', url: data.streamUrl, fileId: data.fileId, filename: data.filename, title: data.filename });
      State.content = { type: 'local', url: data.streamUrl, fileId: data.fileId, filename: data.filename };
      State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
      renderPlayerArea();
      renderNowPlaying();
      toast(`✅ ${data.filename} loaded`);
    } else { toast('Upload failed'); }
  };
  xhr.onerror = () => { toast('Upload error'); if (prog) prog.classList.remove('visible'); };
  const fd = new FormData();
  fd.append('file', file);
  xhr.send(fd);
}

function setupLocalMedia(content, isVideo) {
  stopAllMedia();

  // Show loading indicator
  const art = document.getElementById('audio-art');
  if (art) art.textContent = '⏳';

  // Fetch the ENTIRE file as a Blob — once it's in memory,
  // seeking is instant and never hits the network again
  fetch(content.url)
    .then(r => {
      if (!r.ok) throw new Error('Fetch failed: ' + r.status);
      return r.blob();
    })
    .then(blob => {
      const blobUrl = URL.createObjectURL(blob);
      State.localBlobUrl = blobUrl;

      let el;
      if (isVideo) {
        el = document.getElementById('local-video');
        if (!el) { el = document.createElement('video'); }
        el.playsInline = true;
      } else {
        el = document.createElement('audio');
      }

      el.src = blobUrl;
      el.preload = 'auto';
      State.localMediaEl = el;

      if (art) art.textContent = '🎵';

      el.addEventListener('canplay', () => {
        if (State.playState.currentTime > 0) el.currentTime = State.playState.currentTime;
        if (State.playState.action === 'play') el.play().catch(() => {});
        renderNowPlaying();
        updatePlayButton(State.playState.action === 'play');
      });

      el.addEventListener('ended', () => {
        updatePlayButton(false);
        State.playState.action = 'pause';
      });

      startProgressLoop();
      startHeartbeat();
    })
    .catch(err => {
      console.error('[LocalMedia]', err);
      toast('❌ Failed to load file');
      if (art) art.textContent = '❌';
    });
}

// ══════════════════════════════════════════════════════════════════════════
//  YOUTUBE AUDIO PROXY — Background-capable <audio> element
// ══════════════════════════════════════════════════════════════════════════

async function setupYtAudio(ytUrl, startTime, autoplay) {
  stopAllMedia();

  const art = document.getElementById('audio-art');
  if (art) art.textContent = '⏳';

  const el = new Audio();
  el.src = `/yt-audio?url=${encodeURIComponent(ytUrl)}`;
  el.preload = 'auto';
  State.ytAudioEl = el;

  el.addEventListener('canplay', () => {
    if (startTime > 1) el.currentTime = startTime;
    if (autoplay) el.play().catch(() => {});
    if (art) art.textContent = '🎵';
    renderNowPlaying();
    updatePlayButton(autoplay);
  });

  el.addEventListener('ended', () => {
    updatePlayButton(false);
    State.playState.action = 'pause';
    // Auto-advance playlist
    if (State.content?.type === 'youtube-playlist') {
      const next = (State.playState.videoIndex || 0) + 1;
      if (next < State.ytQueue.length) {
        skipVideo(1);
      }
    }
  });

  el.addEventListener('error', (e) => {
    console.error('[YtAudio] error', e);
    if (art) art.textContent = '❌';
    toast('❌ Could not load YouTube audio');
  });

  startProgressLoop();
  startHeartbeat();
}

State.currentYtIdx = 0;
function loadYtAudioTrack(idx, startTime, autoplay) {
  if (!State.ytQueue[idx]) return;
  State.currentYtIdx = idx;
  const videoId = State.ytQueue[idx].id;
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Update now playing title immediately
  const sn = document.getElementById('song-name');
  if (sn) sn.textContent = State.ytQueue[idx].title || 'Loading…';

  if (State.ytAudioEl) {
    // Reuse existing element — just change src
    State.ytAudioEl.pause();
    State.ytAudioEl.src = `/yt-audio?url=${encodeURIComponent(ytUrl)}`;
    State.ytAudioEl.load();
    State.ytAudioEl.addEventListener('canplay', function handler() {
      State.ytAudioEl.removeEventListener('canplay', handler);
      if (startTime > 1) State.ytAudioEl.currentTime = startTime;
      if (autoplay) State.ytAudioEl.play().catch(() => {});
      updatePlayButton(autoplay);
    });
  } else {
    setupYtAudio(ytUrl, startTime, autoplay);
  }
}

// ─── Add YouTube (single video) ───────────────────────────────────────────
async function addYouTube() {
  const url = document.getElementById('yt-input')?.value.trim();
  if (!url) { toast('Paste a YouTube URL first'); return; }
  if (!getYTId(url)) { toast('Invalid YouTube URL'); return; }
  await applyYouTubeUrl(url);
}

async function applyYouTubeUrl(url) {
  LS.pushHistory('youtube', url);
  closeSheet();

  // Fetch title from server
  let title = url;
  try {
    const info = await fetch(`/yt-info?url=${encodeURIComponent(url)}`).then(r => r.json());
    title = info.title || url;
  } catch {}

  send({ type: 'set-content', contentType: 'youtube', url, title });
  State.content = { type: 'youtube', url, title };
  State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
  renderPlayerArea();
  renderNowPlaying();
}

// ─── Add Playlist ─────────────────────────────────────────────────────────
async function addPlaylist() {
  const url = document.getElementById('pl-input')?.value.trim();
  if (!url) { toast('Paste a YouTube playlist URL'); return; }
  await addPlaylistFromUrl(url);
}

async function addPlaylistFromUrl(url) {
  toast('⏳ Loading playlist…', 6000);

  let ids = null;

  // Check if it's a single video URL with a list param — still a playlist
  if (!url.includes('list=')) {
    toast('❌ Not a playlist URL. Use a URL with ?list= in it.');
    return;
  }

  ids = await getYTPlaylistIds(url);

  if (!ids || !ids.length) {
    toast('❌ Could not load playlist. Make sure it is set to Public on YouTube.');
    return;
  }

  LS.pushHistory('playlist', url);
  closeSheet();

  State.ytQueue = ids;
  send({ type: 'set-content', contentType: 'youtube-playlist', url, title: `Playlist (${ids.length} tracks)` });
  State.content = { type: 'youtube-playlist', url, queue: ids };
  State.playState = { action: 'play', currentTime: 0, videoIndex: 0 };
  renderPlayerArea();
  renderNowPlaying();
  toast(`✅ ${ids.length} tracks loaded`);
}

// ─── Sheet ────────────────────────────────────────────────────────────────
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
