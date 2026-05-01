# SyncPlay 🎵

Listen to music together in real-time. Up to 5 users, no sign-in required.

---

## Features

- 🎵 **Local MP3/MP4** — Host uploads file, everyone hears it streamed live, deleted after playback
- ▶ **YouTube Video** — Paste any YouTube link, synced for all users
- 📋 **YouTube Playlist** — Full playlist queue, plays one by one in order
- 🔒 **Host or Shared controls** — Host decides who can play/pause/skip
- 📱 **PWA** — Install as an app on mobile (no App Store needed)
- 💾 **No sign-in** — Preferences saved locally per device

---

## Tech Stack

- **Frontend** — HTML + CSS + Vanilla JS (single page)
- **Backend** — Node.js + Express + WebSocket (`ws`)
- **File handling** — Multer (upload) + Node streams (serve with range support)
- **Hosting** — Render (free tier)

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Start server
npm start

# 3. Open browser
http://localhost:3000
```

---

## Deploy to Render (Free)

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
# Create a repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/syncplay.git
git push -u origin main
```

### Step 2 — Create a Web Service on Render

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Set these values:

| Field | Value |
|---|---|
| **Environment** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | Free |

4. Click **Deploy**

### Step 3 — Done

Your app will be live at `https://your-app-name.onrender.com`

Share the link with your friends. One person creates a room, shares the 6-digit code, others join.

---

## ⚠️ Important Notes

### Render Free Tier
- Server **sleeps after 15 minutes** of inactivity
- First load after sleep takes **~30 seconds** (Render is spinning it up)
- This is normal — just wait and refresh

### Uploaded Files
- Local files are stored **temporarily on the server only while playing**
- When host skips or leaves, the file is **deleted automatically**
- Files are NOT persisted between sessions

### YouTube Playlist Loading
- Playlists must be **Public** (not unlisted or private)
- Uses YouTube's RSS feed — no API key needed
- May load up to 15 videos per playlist (RSS feed limit)

### YouTube Sync
- Expect **1–2 second drift** between users (YouTube iframe limitation)
- This is acceptable for casual listening

---

## File Structure

```
syncplay/
├── server.js          ← Node.js backend (Express + WebSocket + Multer)
├── package.json
├── .gitignore
└── public/
    ├── index.html     ← App shell
    ├── style.css      ← All styles
    ├── app.js         ← All frontend logic
    ├── manifest.json  ← PWA manifest
    └── sw.js          ← Service Worker (PWA offline)
```

---

## How to Install as PWA (Mobile)

### Android (Chrome)
1. Open the app URL in Chrome
2. Tap the **three-dot menu** → **Add to Home Screen**
3. Tap **Add**

### iPhone (Safari)
1. Open the app URL in **Safari**
2. Tap the **Share** button (bottom center)
3. Tap **Add to Home Screen**
4. Tap **Add**

---

## Room Flow

```
1. Open app → Enter name
2. Host taps "Create Room" → gets 6-digit code
3. Host taps "Add Content" → picks Local File / YouTube / Playlist
4. Friends open app → Enter name → enter room code → Join
5. Everyone sees and hears the same content
6. Host can toggle "Shared Control" so anyone can play/pause/skip
```
