# HDF Studio

An open-source PDF reader and editor for Windows (macOS and Linux to follow), built for speed
and batch workflows. Licensed under the GNU AGPL v3 or later.

## Layout

- **Task ribbon**: the tabs across the top are jobs, not menus: Home, Comment, Edit, Organize,
  Fill & Sign, Protect, Convert and Automate. Each holds the tools for that job, grouped.
  Choosing a tool by its shortcut brings its tab forward.
- **Tools search** (Ctrl+K): type any part of a tool's name to run it; each result shows its tab.
- **Panel rail** (left): Pages, Bookmarks, Search results and Comments. Click the open panel's
  icon again to fold the sidebar away.
- **Page bar** (floating, bottom): page number, zoom and fit.
- **Start screen**: quick actions and, in the desktop app, recent files.

Colours follow the Hive Engineering palette (charcoal #575859, cyan #05C7F2, lime #C5D932,
yellow #F2CB05, ink #0D0D0D), with light and dark themes.

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
`compress`, `split`, `redact`, `sanitize` and `ocr` (recognize text in scans; always runs first, so a
later `redact` step finds the text). Save your own recipes next to the built-in ones. Bates numbers continue across files.

The same recipes run from the terminal:

```sh
npm run hdfstudio -- run "Bates" "D:/Case 42/Exhibits" -r -o "D:/Case 42/Stamped"
npm run hdfstudio -- run - *.pdf --step 'stamp text="DRAFT" position=diagonal' --name "{name}-draft"
npm run hdfstudio -- merge -o binder.pdf ch1.pdf ch2.pdf ch3.pdf
npm run hdfstudio -- split big.pdf --bookmarks
npm run hdfstudio -- search "invoice 1042" ./archive -r --csv > hits.csv
npm run hdfstudio -- fill form.pdf people.csv --name "{Last} - {First}" --flatten
npm run hdfstudio -- sign ./contracts --cert me.pfx --password **** --reason Approved --page 1 --rect "350,700,570,760" --tsa
npm run hdfstudio -- verify ./contracts
npm run hdfstudio -- ocr ./scans -r -o ./searchable     # make scanned PDFs searchable (add --lang eng+fra for other languages)
npm run hdfstudio -- run "OCR scans, then redact" ./scans -o ./clean
npm run hdfstudio -- compare contract-v1.pdf contract-v2.pdf -o changes.pdf
npm run hdfstudio -- make-fillable ./paper-forms -o ./fillable   # detect fields on flat forms
npm run hdfstudio -- comments draft.pdf review-ann.pdf review-bob.xfdf -o merged.pdf   # combine reviewers' comments
npm run hdfstudio -- watch "D:/Scans/Inbox" --recipe "Make scans searchable"   # runs until Ctrl+C
npm run hdfstudio -- tag ./reports -o ./accessible --lang en-CA   # tag for screen readers
npm run hdfstudio -- check ./outgoing -r                # PDF/A, accessibility and security report
npm run hdfstudio -- pdfa ./to-archive -o ./archive      # PDF/A-2b (needs Ghostscript)
npm run hdfstudio -- recipes          # list built-in recipes and step types
```

## User guide (F1)

The searchable user guide opens with F1 (at the topic for the current tool or ribbon tab) or the
**?** button in the app bar. It's bundled with the app, so it works offline.

```
src/help/topics/*.md         One Markdown file per topic (front matter: title, section, order,
                             keywords, context = the tabs/tools F1 opens it for)
src/help/markdown.ts         The guide's Markdown dialect ([[Ctrl+K]] keys, figures, call-outs,
                             {{ribbon:home}} and {{shortcuts}} blocks built from the live app)
src/help/search.ts           Section-level full-text search with synonyms and stemming
src/ui/help.ts               The guide window
public/help/                 Screenshots (*.png) and diagrams (d-*.svg)
```

Refresh the guide's pictures after interface changes:

```sh
npx tsx scripts/help/screenshots.ts          # recapture every screenshot from the running UI
npx tsx scripts/help/screenshots.ts callout  # only shots whose name contains "callout"
python3 scripts/help/shrink.py               # shrink new shots (256-colour PNG, about a third of the size)
python3 scripts/help/diagrams.py             # redraw the diagrams
```

The screenshot tool opens a sample engineering sheet (`scripts/help/sample-drawing.ts`) in the
browser preview and drives the real interface with Playwright. `npm test` checks that every guide
link and picture exists, every ribbon tab has a topic, keys use Windows names, and search finds
the right topic for common questions.

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
| Tools: sign, redact, edit page text & images | G, D, E |
| Find and redact | Ctrl+Shift+R |
| Recognize text (OCR) | Ctrl+Shift+O |
| Compare files | Ctrl+Shift+C |
| Prepare form (form designer) | Ctrl+Shift+F, then T / C / R / D / L / S for field types |
| Select pages | Click, Ctrl+click, Shift+click; drag to reorder; drop PDFs between thumbnails to insert |

## Roadmap

| # | Area | What it covers | How |
|---|---|---|---|
| 1 | View & search | Tabs, thumbnails, outline, zoom, full-text search | Done |
| 2 | Organize & combine | Merge, split, reorder, rotate, extract, delete, insert pages | Done |
| 3 | Automation | Batch panel, saved recipes, `hdfstudio` CLI, stamps/Bates/watermarks, watch folders (app and CLI) | Done |
| 4 | Comment & review | Highlight, notes, shapes, ink, stamps, threaded replies, XFDF export and import | Done |
| 5 | Redaction & security | Permanent redaction (text, images, vector art), find-and-redact by text/regex/patterns, hidden-data removal, AES-256 passwords and permissions | Done |
| 6 | Forms & e-signatures | Form designer (text, check box, radio, dropdown, list, signature fields; move, resize, properties), Detect fields to make flat forms fillable (app and CLI), fill/flatten, CSV mail merge, drawn/typed/image signatures, certificate (PKCS#7, .pfx) digital signatures with RFC 3161 trusted timestamps, validation (including timestamps), batch signing | Done |
| 7 | Edit text & images | Edit existing text blocks in place (font/size/colour matched), add text, move/resize/replace/insert/delete/export images | Done (custom font embedding next) |
| 8 | Create & convert | Images, XPS, EPUB, HTML, text to PDF; PDF to Word, images, text, HTML, SVG; Office files via optional LibreOffice | Done |
| 9 | OCR | Make scanned PDFs searchable (invisible text layer), 44 languages (English bundled; others download once, then work offline; two at a time for mixed documents), any script searchable including Arabic, Hebrew, CJK and Indic, scan detection on open, batch and CLI OCR | Done |
| 10 | Compare | Word-level diff across the whole document (reflowed text isn't flagged), pixel diff for images and drawings, changes marked as comments with a clickable list, CLI report | Done |
| 11 | Compliance & accessibility | Document check (PDF/A, accessibility, security) with one-click fixes; Make accessible: automatic tagging (headings by size, paragraphs, lists, ruled tables with header rows, figures, links, form fields; running headers, footers and decoration as artifacts; reading order, language, title, tab order) plus an alt-text review with previews; PDF/A-2b via optional Ghostscript plus a built-in sRGB output intent; `hdfstudio tag` and a batch recipe step | Done |
| 12 | Collaboration | Review threads and status (Accepted, Rejected, Completed…), status and reviewer filters, merge reviewers' PDF copies or XFDF files without duplicates, `hdfstudio comments` CLI | Done (live shared review parked) |
