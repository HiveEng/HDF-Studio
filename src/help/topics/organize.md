---
title: Organizing pages
section: Pages
order: 1
keywords: insert pages, delete pages, rotate pages, reorder, move pages, duplicate, reverse, extract pages, split, merge, combine, blank page, page range, thumbnails, odd, even
context: tab:organize
summary: Insert, delete, rotate, reorder, extract, split and merge pages.
---
# Organizing pages

![The Organize tab](ribbon-organize.png "wide")

Most commands act on the pages **selected** in the Pages panel, or on the current page if none are selected. Select with [[Ctrl]]+click and [[Shift]]+click on thumbnails; see [Sidebar panels](#panels/pages).

## Inserting pages

**From file** inserts all or some pages of other PDFs:

1. Click **Organize › From file** and pick one or more files.
2. **Pages:** `all`, or a range such as `1-3, 8`.
3. **Put them:** at the beginning, at the end, before page…, or after page…, and the page number.

![Where inserted pages go](d-insert.svg "plain")

You can also drag PDF files from File Explorer onto the Pages panel, between the thumbnails where they should go.

**Blank page** adds an empty page after the current one. **Duplicate** copies the selected pages.

## Rearranging

- Drag thumbnails up or down to move pages.
- **Rotate left** [[Ctrl+[]] and **Rotate right** [[Ctrl+]]] turn the selected pages 90°.
- **Reverse order** flips the whole document, useful for scans fed in backwards.
- **Delete** (or [[Delete]] in the Pages panel) removes the selected pages.
- **Select all** selects every page.

## Extracting and splitting

- **Extract** copies pages to a new tab. Type a range such as `1-3, 7, 10-`, `odd` or `even`.
- **Split** saves the document as several files: every N pages, by page ranges (separate files with `|`, for example `1-3 | 4-8 | 9-`), or one file per top-level bookmark.

## Merging

**Merge files** ([[Ctrl+Shift+M]]) combines several PDFs into a new document, in the order you choose, with a bookmark for each file.

## Page ranges

Wherever {{app}} asks for pages you can type:

| You type | Pages |
|---|---|
| `5` | page 5 |
| `1-3, 7` | 1, 2, 3 and 7 |
| `10-` | 10 to the end |
| `odd` / `even` | every odd or even page |
| `all` | every page |
