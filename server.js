const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// ─── Multer ───────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, id + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^(audio|video)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only audio/video files allowed'));
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
  const fp = path.join('./uploads/', filename);
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
}

// ─── Static ───────────────────────────────────────────────────────────────
app.use(express.static('public'));
app.use(express.json());

// ─── Upload ───────────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  console.log(`[Upload] ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)}MB) → ${req.file.filename}`);
  res.json({
    fileId: req.file.filename,
    filename: req.file.originalname,
    streamUrl: `/stream/${req.file.filename}`,
  });
});

// ─── Stream (robust range support) ───────────────────────────────────────
app.get('/stream/:filename', (req, res) => {
  const fp = path.join('./uploads/', req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found');

  const stat = fs.statSync(fp);
  const size = stat.size;
  const ext = path.extname(req.params.filename).toLowerCase();

  const mimeMap = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/mp4',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');

  const rangeHeader = req.headers.range;

  if (!rangeHeader) {
    // No range — send full file
    res.setHeader('Content-Length', size);
    res.status(200);
    const stream = fs.createReadStream(fp);
    stream.on('error', err => { console.error('[Stream] error:', err); });
    stream.pipe(res);
    return;
  }

  // Parse range safely
  const rangeStr = rangeHeader.replace(/bytes=/, '');
  const [startStr, endStr] = rangeStr.split('-');
  let start = parseInt(startStr, 10);
  // Serve 1MB chunks for smooth streaming/seeking
  const CHUNK = 1024 * 1024;
  let end = endStr && endStr.trim() !== '' ? parseInt(endStr, 10) : Math.min(start + CHUNK, size - 1);

  // Clamp
  if (isNaN(start)) start = 0;
  end = Math.min(end, size - 1);

  if (start >= size || start > end) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  const chunkSize = end - start + 1;
  console.log(`[Stream] ${path.basename(fp)} | bytes ${start}-${end}/${size}`);

  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', chunkSize);
  res.status(206);

  const stream = fs.createReadStream(fp, { start, end });
  stream.on('error', err => {
    console.error('[Stream] read error:', err);
    if (!res.headersSent) res.status(500).end();
  });
  stream.pipe(res);
});

// ─── Delete ───────────────────────────────────────────────────────────────
app.delete('/file/:filename', (req, res) => {
  deleteFile(req.params.filename);
  res.json({ ok: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${ip}. Total: ${wss.clients.size}`);
  ws.roomCode = null;
  ws.isHost = false;
  ws.username = 'User';

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Ping keep-alive
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    const room = ws.roomCode ? rooms[ws.roomCode] : null;

    switch (msg.type) {

      case 'create-room': {
        const code = generateCode();
        ws.roomCode = code;
        ws.isHost = true;
        ws.username = (msg.username || 'Host').substring(0, 20);
        rooms[code] = {
          host: ws,
          users: [ws],
          content: null,
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
        if (room.content && room.content.fileId) deleteFile(room.content.fileId);
        room.content = {
          type: msg.contentType,
          url: msg.url || null,
          fileId: msg.fileId || null,
          filename: msg.filename || null,
          queue: msg.queue || null,
        };
        room.playState = { action: 'pause', currentTime: 0, videoIndex: 0 };
        console.log(`[Room] ${ws.roomCode} content set: ${msg.contentType}`);
        broadcast(room, null, { type: 'content-changed', content: room.content, playState: room.playState });
        break;
      }

      case 'play-state': {
        if (!room) return;
        if (!ws.isHost && room.controlMode === 'host') return;
        room.playState = {
          action: msg.action,
          currentTime: msg.currentTime || 0,
          videoIndex: msg.videoIndex || 0,
        };
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
        ws.send(JSON.stringify({
          type: 'sync-response',
          content: room.content,
          playState: room.playState,
          controlMode: room.controlMode,
        }));
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
      console.log(`[Room] Host left ${ws.roomCode} — room closed`);
      if (room.content && room.content.fileId) deleteFile(room.content.fileId);
      broadcast(room, null, { type: 'host-left' });
      delete rooms[ws.roomCode];
    } else {
      console.log(`[Room] ${ws.username} left ${ws.roomCode}`);
      broadcast(room, ws, { type: 'user-left', username: ws.username });
    }
  });

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncPlay running on port ${PORT}`));
