# Panels — Beacon Hosting Dashboard

A custom Electron desktop control panel for Beacon Hosting.

## Features
- **Server list** — sidebar with live status dots
- **Power controls** — Start / Stop / Restart / Kill
- **Console** — live log polling + command input
- **SFTP File Manager** — full-featured:
  - Browse directories, navigate, breadcrumb path
  - Upload (button + drag & drop)
  - Download files
  - Create folders & new files
  - Delete files & folders (recursive)
  - Rename / move
  - Right-click context menu
  - **In-browser themed editor** (matches your active theme)
    - Line numbers, cursor position, Ctrl+S to save
    - Tab-key indentation, unsaved indicator
- **3 Themes** — Sakura 🌸 · Glossy 💎 · Moon's Edge 🌙
  - Editor syntax colours adapt per theme

## Setup

```bash
npm install
npm start
```

This runs the Express backend (`server.js`) and Electron app together.

## First Run
1. Click ⚙ (Settings) in the titlebar
2. Paste your Beacon API token (`bpat_…`)
3. Click **＋ Add Server** in the sidebar
4. Enter your server's UUID from the Beacon dashboard

## SFTP
In the **Files** tab of any server, enter your SFTP credentials.  
Beacon typically uses:
- Host: your server's IP or SFTP hostname
- Port: 22
- Username / Password: from the Beacon panel

Connections are pooled per-server and auto-disconnect after 10 minutes idle.

## API Notes
The server proxy normalises several Beacon API response shapes that differ from docs:
- Resources: tries `/resources` then `/utilization`
- Logs: tries `/logs` then `/console`
- Power: sends `{ signal: action }` as Beacon expects

## Files
```
panels_app/
├── main.js          Electron main process
├── preload.js       Secure IPC bridge
├── server.js        Express API proxy + SFTP backend
├── package.json
├── data/
│   ├── settings.json   (token + theme, stored locally)
│   └── servers.json    (your server list)
└── public/
    ├── index.html
    ├── styles.css       (all 3 themes)
    └── app.js           (all frontend logic)
```


### Future additions

- Resource monitor
- Customizeable themes
- plugins handeler
- moveable widgets
