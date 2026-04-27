# Building Panels.exe  (portable single file)

## Requirements

- Node.js 18+  →  https://nodejs.org
- Run once:  `npm install`

## Build

```bash
npm run build
```

Output: `dist/Panels.exe`

That's the only file you need. Copy it anywhere and run it —
no installer, no extra folders required.

## What "portable" means here

- Everything (Electron, Node, your app, node_modules) is packed
  into one self-contained executable.
- On first launch it extracts itself to a temp folder and runs.
- Settings + servers.json are saved to:
    Windows:  %APPDATA%\panels-beacon\data\
    Mac:      ~/Library/Application Support/panels-beacon/data/
    Linux:    ~/.config/panels-beacon/data/
  So your token and server list survive updates.

## Icon (optional)

Place files in a `build/` folder before building:
- `build/icon.ico`   (256×256, Windows)
- `build/icon.icns`  (Mac)
- `build/icon.png`   (512×512, Linux)

The build works fine without them — Electron's default icon is used.

## Other targets

```bash
npm run build:win    # → dist/Panels.exe        (Windows portable)
npm run build:mac    # → dist/Panels-2.1.0.dmg  (macOS)
npm run build:linux  # → dist/Panels-2.1.0.AppImage
```

## Development (no build needed)

```bash
npm start   # Express server + Electron window
npm run dev # Same but nodemon auto-restarts on server.js edits
```
