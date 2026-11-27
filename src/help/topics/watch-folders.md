---
title: Watch folders and the command line
section: Automate
order: 2
keywords: watch folder, hot folder, automatic, scanner folder, shared drive, command line, CLI, hds, hdfstudio, script, scheduled task, server
summary: Process every PDF dropped into a folder automatically, or script {{app}} from the command line.
---
# Watch folders and the command line

## Watch folders

A watch folder runs a recipe on every PDF that lands in it while {{app}} is open. Point a scanner or a shared drive at it, and files come out processed.

1. Click **Automate › Watch folders**.
2. Click **Add watch folder** and pick the folder.
3. Choose the recipe to run.

Results go to a `hdfstudio-out` folder inside the watched folder, and the originals move to `processed`. The footer shows *Watching…* while folders are active; click it to open the panel.

## The command line

For IT and scripting, the same engine runs without the window as the `hds` command-line tool. It comes with the {{app}} source code and needs Node.js. Some useful commands:

| Command | Does |
|---|---|
| `hds run "<recipe>" <files or folders>` | Runs a recipe on every PDF |
| `hds watch <folder> --recipe <name>` | A watch folder that keeps running without the app |
| `hds ocr <files or folders>` | Makes scanned PDFs searchable |
| `hds compare old.pdf new.pdf -o report.pdf` | Lists what changed and writes a marked-up report |
| `hds export <files> --to png --dpi 300` | PDFs to images, Word, HTML, text or SVG |
| `hds check <files>` | PDF/A, accessibility and security check |
| `hds merge`, `split`, `extract`, `sign`, `verify` | Page and signature jobs |

Run `hds` on its own to list every command and option, and `hds recipes` to list the recipes and step types.
