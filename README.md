# HDF Studio

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

## Batch and the `hdfstudio` command line tool

The **Batch** panel (Ctrl+B) runs a recipe over any number of PDFs. A recipe is a list of steps, one per
line, e.g.

```
stamp text="Page {page} of {pages}" position=bottom-center
stamp text={bates} position=bottom-right batesPrefix=ACME batesDigits=6
stamp text=CONFIDENTIAL position=diagonal
protect ownerPassword=s3cret allowCopy=false
```

Steps: `rotate`, `delete`, `keep`, `reverse`, `stamp` (headers/footers, page numbers, Bates, watermarks),
`metadata` (set or scrub), `protect` (AES-256 passwords and permissions), `unprotect`, `flatten`,
`compress`, `split`. Save your own recipes next to the built-in ones. Bates numbers continue across files.

The same recipes run from the terminal:

```sh
npm run hdfstudio -- run "Bates" "D:/Case 42/Exhibits" -r -o "D:/Case 42/Stamped"
npm run hdfstudio -- run - *.pdf --step 'stamp text="DRAFT" position=diagonal' --name "{name}-draft"
npm run hdfstudio -- merge -o binder.pdf ch1.pdf ch2.pdf ch3.pdf
npm run hdfstudio -- split big.pdf --bookmarks
npm run hdfstudio -- search "invoice 1042" ./archive -r --csv > hits.csv
npm run hdfstudio -- fill form.pdf people.csv --name "{Last} - {First}" --flatten
npm run hdfstudio -- sign ./contracts --cert me.pfx --password **** --reason Approved --page 1 --rect "350,700,570,760"
npm run hdfstudio -- verify ./contracts
npm run hdfstudio -- recipes          # list built-in recipes and step types
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
| Batch panel | Ctrl+B |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Merge files | Ctrl+Shift+M |
| Rotate selected pages left/right | Ctrl+[ / Ctrl+] |
| Delete selected pages (in thumbnails) | Delete |
| Tools: hand, select text, highlight, underline, strikeout | V, T, H, U, K |
| Tools: note, text box, rectangle, ellipse, arrow, pen | N, X, R, O, A, P |
| Tools: sign, redact | G, D |
| Find and redact | Ctrl+Shift+R |
| Select pages | Click, Ctrl+click, Shift+click; drag to reorder; drop PDFs between thumbnails to insert |

## Roadmap

| # | Area | What it covers | How |
|---|---|---|---|
| 1 | View & search | Tabs, thumbnails, outline, zoom, full-text search | Done |
| 2 | Organize & combine | Merge, split, reorder, rotate, extract, delete, insert pages | Done |
| 3 | Automation | Batch panel, saved recipes, `hdfstudio` CLI, stamps/Bates/watermarks; watch folders next | Done (watch folders pending) |
| 4 | Comment & review | Highlight, notes, shapes, ink, stamps, replies, XFDF import/export | MuPDF annotations |
| 5 | Redaction & security | Permanent redaction (text, images, vector art), find-and-redact by text/regex/patterns, hidden-data removal, AES-256 passwords and permissions | Done |
| 6 | Forms & e-signatures | Fill/flatten forms, CSV mail merge, drawn/typed/image signatures, certificate (PKCS#7, .pfx) digital signatures, validation, batch signing | Done (form designer and timestamps next) |
| 7 | Edit text & images | Edit existing text runs, add text, replace/move/insert images | Content-stream editing on MuPDF |
| 8 | Create & convert | Images, XPS, EPUB, HTML, text to PDF; PDF to images, text, HTML; Office files via optional LibreOffice | MuPDF document writers |
| 9 | OCR | Make scanned PDFs searchable (invisible text layer), batch OCR | Tesseract (Apache-2.0) |
| 10 | Compare | Side-by-side text diff and visual (pixel) diff with change list | Engine text extraction + render diff |
| 11 | Compliance | PDF/A conversion and checks, accessibility checks, audit log of batch runs | Later phase |
| 12 | Collaboration | Shared review threads on comments, review status | Later phase |
