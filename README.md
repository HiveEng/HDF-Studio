# Quire

An open-source PDF reader and editor for Windows (macOS and Linux to follow), built for speed
and batch workflows. Licensed under the GNU AGPL v3 or later.

## Stack

- **Desktop shell:** [Tauri 2](https://tauri.app) (Rust). Small installers, native file dialogs,
  single-instance "Open with" support.
- **PDF engine:** [MuPDF](https://mupdf.com) via the official `mupdf` WebAssembly package (AGPL-3.0),
  running in a Web Worker so the UI never blocks.
- **UI:** TypeScript + Vite, no framework.

```
src/engine/core.ts    Engine API over MuPDF (open, render, search, save…). Also used by tests/CLI.
src/engine/worker.ts  Hosts the engine in a Web Worker.
src/engine/client.ts  Async proxy the UI calls.
src/main.ts           Viewer UI: tabs, thumbnails, outline, zoom, search, command palette.
src/platform.ts       File open/save for Tauri, with a browser fallback for dev.
src-tauri/            Desktop shell and Windows installer config.
```

## Develop

Prerequisites on Windows: Node 20+, Rust (via rustup), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) (WebView2 ships with Windows 10/11,
plus "Desktop development with C++" from Visual Studio Build Tools).

```sh
npm install
npm run tauri dev       # desktop app with hot reload
npm run dev             # same UI in a browser at http://localhost:1420
npm test                # engine tests (Node)
npm run tauri build     # Windows installers in src-tauri/target/release/bundle/
```

## Keyboard

| Action | Keys |
|---|---|
| All commands | Ctrl+K |
| Open / Save / Save as | Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Find, next/previous match | Ctrl+F, Enter / Shift+Enter, F3 / Shift+F3 |
| Zoom in/out, actual size, fit width, fit page | Ctrl+= / Ctrl+-, Ctrl+1, Ctrl+2, Ctrl+0 (or Ctrl+wheel) |
| Go to page, next/prev page, first/last | Ctrl+G, PageDown / PageUp, Home / End |
| Next/previous tab, close tab | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+W |
| Toggle sidebar | F4 |

## Roadmap

| # | Area | What it covers | How |
|---|---|---|---|
| 1 | View & search | Tabs, thumbnails, outline, zoom, full-text search | Done |
| 2 | Organize & combine | Merge, split, reorder, rotate, extract, delete, insert pages | MuPDF page grafting |
| 3 | Automation | Batch panel, saved recipes, `quire` CLI, watch folders | Engine core shared by UI and CLI |
| 4 | Comment & review | Highlight, notes, shapes, ink, stamps, replies, XFDF import/export | MuPDF annotations |
| 5 | Redaction & security | Permanent redaction (text, images, vector art), search-and-redact, metadata scrub, passwords and permissions (AES-256) | MuPDF `applyRedactions`, encrypted save |
| 6 | Forms & e-signatures | Fill/flatten forms, drawn/typed/image signatures, certificate (PKCS#7) digital signatures, signature validation | MuPDF widgets; certificate signing in the Rust shell |
| 7 | Edit text & images | Edit existing text runs, add text, replace/move/insert images | Content-stream editing on MuPDF |
| 8 | Create & convert | Images, XPS, EPUB, HTML, text to PDF; PDF to images, text, HTML; Office files via optional LibreOffice | MuPDF document writers |
| 9 | OCR | Make scanned PDFs searchable (invisible text layer), batch OCR | Tesseract (Apache-2.0) |
| 10 | Compare | Side-by-side text diff and visual (pixel) diff with change list | Engine text extraction + render diff |
| 11 | Compliance | PDF/A conversion and checks, accessibility checks, audit log of batch runs | Later phase |
| 12 | Collaboration | Shared review threads on comments, review status | Later phase |
