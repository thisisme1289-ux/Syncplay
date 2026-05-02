const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ytdl = require('@distube/ytdl-core');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// ─── Multer ───────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase());
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    /^(audio|video)\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Audio/video only'));
  },
});

// ─── Rooms ────────────────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function broadcast(room, excludeWs, msg) {
  const data = JSON.stringify(msg);
  room.users.forEach(u => {
    if (u !== excludeWs && u.readyState === WebSocket.OPEN) u.send(data);
  });
}
function deleteFile(filename) {
  if (!filename) return;
  try {
    const fp = path.join('./uploads/', filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
}

// ─── Static ───────────────────────────────────────────────────────────────
app.use(express.static('public'));
app.use(express.json());

// ─── Upload ───────────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  console.log(`[Upload] ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)}MB)`);
  res.json({
    fileId: req.file.filename,
    filename: req.file.originalname,
    streamUrl: `/stream/${req.file.filename}`,
  });
});

// ─── Stream Local File ─────────────────────────────────────────────────────
// We serve the ENTIRE file in one shot with no chunking.
// The client fetches it once as a Blob, stores it in memory,
// and all seeking is handled locally — zero network round trips on seek.
app.get('/stream/:filename', (req, res) => {
  const fp = path.join('./uploads/', req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');

  const stat = fs.statSync(fp);
  const size = stat.size;
  const ext = path.extname(req.params.filename).toLowerCase();
  const mimeMap = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',  '.wav': 'audio/wav',  '.flac': 'audio/flac',
    '.mp4': 'video/mp4',  '.webm': 'video/webm', '.mov': 'video/mp4',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', size);
  res.setHeader('Accept-Ranges', 'none'); // Tell browser: don't chunk, take it all
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.status(200);

  const stream = fs.createReadStream(fp);
  stream.on('error', err => console.error('[Stream]', err));
  stream.pipe(res);
});

// ─── YouTube Audio Proxy ───────────────────────────────────────────────────
// Extracts audio-only stream from YouTube and pipes it to an <audio> element.
// This allows background playback on mobile (no video = no iframe restrictions).
app.get('/yt-audio', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');

  try {
    console.log(`[YT-Audio] Fetching audio for: ${url}`);

    const info = await ytdl.getInfo(url);
    // Pick best audio-only format
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: 'audioonly',
    });

    if (!format) return res.status(404).send('No audio format found');

    res.setHeader('Content-Type', format.mimeType?.split(';')[0] || 'audio/webm');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    // Also send the video title for the now-playing bar
    res.setHeader('X-Video-Title', encodeURIComponent(info.videoDetails.title));

    const stream = ytdl.downloadFromInfo(info, { format });
    stream.on('error', err => {
      console.error('[YT-Audio] stream error:', err);
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);

  } catch (err) {
    console.error('[YT-Audio] error:', err.message);
    res.status(500).send('Could not fetch audio: ' + err.message);
  }
});

// ─── YouTube Info (title + duration for now-playing) ─────────────────────
app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const info = await ytdl.getInfo(url);
    res.json({
      title: info.videoDetails.title,
      duration: parseInt(info.videoDetails.lengthSeconds),
      thumbnail: info.videoDetails.thumbnails?.pop()?.url || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete File ──────────────────────────────────────────────────────────
app.delete('/file/:filename', (req, res) => {
  deleteFile(req.params.filename);
  res.json({ ok: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] Connected from ${ip}. Total: ${wss.clients.size}`);
  ws.roomCode = null;
  ws.isHost = false;
  ws.username = 'User';

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    const room = ws.roomCode ? rooms[ws.roomCode] : null;

    switch (msg.type) {

      case 'create-room': {
        const code = generateCode();
        ws.roomCode = code;
        ws.isHost = true;
        ws.username = (msg.username || 'Host').substring(0, 20);
        rooms[code] = {
          host: ws, users: [ws], content: null,
          playState: { action: 'pause', currentTime: 0, videoIndex: 0 },
          controlMode: 'host',
        };
        console.log(`[Room] Created: ${code} by ${ws.username}`);
        ws.send(JSON.stringify({ type: 'room-created', roomCode: code }));
        break;
      }

      case 'join-room': {
        const target = rooms[msg.roomCode];
        if (!target) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the code.' }));
          return;
        }
        ws.roomCode = msg.roomCode;
        ws.isHost = false;
        ws.username = (msg.username || 'User').substring(0, 20);
        target.users.push(ws);
        console.log(`[Room] ${ws.username} joined ${msg.roomCode}`);
        ws.send(JSON.stringify({
          type: 'room-joined',
          roomCode: msg.roomCode,
          content: target.content,
          playState: target.playState,
          controlMode: target.controlMode,
        }));
        broadcast(target, ws, { type: 'user-joined', username: ws.username });
        break;
      }

      case 'set-content': {
        if (!room) return;
        if (!ws.isHost && room.controlMode === 'host') return;
        if (room.content?.fileId) deleteFile(room.content.fileId);
        room.content = {
          type: msg.contentType,
          url: msg.url || null,
          fileId: msg.fileId || null,
          filename: msg.filename || null,
          title: msg.title || null,
          queue: msg.queue || null,
        };
        room.playState = { action: 'pause', currentTime: 0, videoIndex: 0 };
        console.log(`[Room] ${ws.roomCode} content: ${msg.contentType}`);
        broadcast(room, null, { type: 'content-changed', content: room.content, playState: room.playState });
        break;
      }

      case 'play-state': {
        if (!room) return;
        if (!ws.isHost && room.controlMode === 'host') return;
        room.playState = { action: msg.action, currentTime: msg.currentTime || 0, videoIndex: msg.videoIndex || 0 };
        broadcast(room, ws, { type: 'play-state', ...room.playState });
        break;
      }

      case 'heartbeat': {
        if (!room || !ws.isHost) return;
        room.playState.currentTime = msg.currentTime || 0;
        room.playState.videoIndex = msg.videoIndex || 0;
        break;
      }

      case 'toggle-control': {
        if (!room || !ws.isHost) return;
        room.controlMode = msg.mode === 'shared' ? 'shared' : 'host';
        broadcast(room, null, { type: 'control-mode', mode: room.controlMode });
        break;
      }

      case 'sync-request': {
        if (!room) return;
        ws.send(JSON.stringify({ type: 'sync-response', content: room.content, playState: room.playState, controlMode: room.controlMode }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms[ws.roomCode];
    if (!room) return;
    room.users = room.users.filter(u => u !== ws);
    if (ws.isHost) {
      console.log(`[Room] Host left ${ws.roomCode} — closing`);
      if (room.content?.fileId) deleteFile(room.content.fileId);
      broadcast(room, null, { type: 'host-left' });
      delete rooms[ws.roomCode];
    } else {
      broadcast(room, ws, { type: 'user-left', username: ws.username });
    }
  });

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncPlay on port ${PORT}`));
