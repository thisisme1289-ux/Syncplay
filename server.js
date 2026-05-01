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

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// ─── Multer: Disk Storage ──────────────────────────────────────────────────
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
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    const allowed = /^(audio|video)\//;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only audio and video files allowed'));
  },
});

// ─── In-Memory Rooms ──────────────────────────────────────────────────────
// rooms[code] = { host: ws, users: [ws,...], content, playState, controlMode }
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcast(room, excludeWs, msg) {
  const data = JSON.stringify(msg);
  room.users.forEach((u) => {
    if (u !== excludeWs && u.readyState === WebSocket.OPEN) {
      u.send(data);
    }
  });
}

function deleteFile(filename) {
  if (!filename) return;
  const fp = path.join('./uploads/', filename);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
}

// ─── Static Files ─────────────────────────────────────────────────────────
app.use(express.static('public'));
app.use(express.json());

// ─── Upload Endpoint ──────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({
    fileId: req.file.filename,
    filename: req.file.originalname,
    streamUrl: `/stream/${req.file.filename}`,
  });
});

// ─── Stream Endpoint (with Range support for seek) ────────────────────────
app.get('/stream/:filename', (req, res) => {
  const fp = path.join('./uploads/', req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found');

  const stat = fs.statSync(fp);
  const size = stat.size;
  const ext = path.extname(req.params.filename).toLowerCase();
  const mime = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'audio/mpeg';
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : size - 1;
    const chunk = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunk,
      'Content-Type': mime,
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': size,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(fp).pipe(res);
  }
});

// ─── Delete File Endpoint ─────────────────────────────────────────────────
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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const room = ws.roomCode ? rooms[ws.roomCode] : null;

    switch (msg.type) {

      // ── Ping (keep-alive from client) ─────────────────────────────────
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        return;

      // ── Create Room ──────────────────────────────────────────────────
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
        ws.send(JSON.stringify({ type: 'room-created', roomCode: code }));
        break;
      }

      // ── Join Room ────────────────────────────────────────────────────
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

      // ── Set Content (host or shared) ─────────────────────────────────
      case 'set-content': {
        if (!room) return;
        if (!ws.isHost && room.controlMode === 'host') return;
        // Delete previous uploaded file
        if (room.content && room.content.fileId) deleteFile(room.content.fileId);
        room.content = {
          type: msg.contentType,
          url: msg.url || null,
          fileId: msg.fileId || null,
          filename: msg.filename || null,
        };
        room.playState = { action: 'pause', currentTime: 0, videoIndex: 0 };
        broadcast(room, null, { type: 'content-changed', content: room.content, playState: room.playState });
        break;
      }

      // ── Play State (play/pause/seek/skip) ────────────────────────────
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

      // ── Heartbeat (host keeps currentTime current for late joiners) ───
      case 'heartbeat': {
        if (!room || !ws.isHost) return;
        room.playState.currentTime = msg.currentTime || 0;
        room.playState.videoIndex = msg.videoIndex || 0;
        break;
      }

      // ── Toggle Control Mode ──────────────────────────────────────────
      case 'toggle-control': {
        if (!room || !ws.isHost) return;
        room.controlMode = msg.mode === 'shared' ? 'shared' : 'host';
        broadcast(room, null, { type: 'control-mode', mode: room.controlMode });
        break;
      }

      // ── Sync Request (guest asking for current state) ─────────────────
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
    room.users = room.users.filter((u) => u !== ws);
    if (ws.isHost) {
      if (room.content && room.content.fileId) deleteFile(room.content.fileId);
      broadcast(room, null, { type: 'host-left' });
      delete rooms[ws.roomCode];
    } else {
      broadcast(room, ws, { type: 'user-left', username: ws.username });
    }
  });

  ws.on('error', () => {});
});

// ─── Start Server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SyncPlay running on http://localhost:${PORT}`);
});
