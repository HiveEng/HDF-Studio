---
title: Page numbers, Bates numbers and watermarks
section: Pages
order: 2
keywords: page numbers, Page X of Y, Bates, Bates numbering, header, footer, watermark, DRAFT, CONFIDENTIAL, stamp text, legal
summary: Add page numbers, Bates numbers, headers, footers and watermarks.
---
# Page numbers, Bates numbers and watermarks

**Organize › Watermark, numbers & Bates** opens the recipe window for the current document. Pick a ready-made recipe, adjust it, and click **Run**:

| Recipe | Adds |
|---|---|
| Add page numbers (Page X of Y) | `Page 3 of 12` at the bottom centre |
| Bates number (bottom right) | `ABC000001`, `ABC000002`… with your prefix, digits and starting number |
| Watermark DRAFT / CONFIDENTIAL | Large diagonal text across each page |

The **stamp text** step behind these recipes can put any text at the top or bottom (left, centre or right), in the centre, or diagonally, in your chosen size, colour and opacity. It understands these fields:

| Field | Becomes |
|---|---|
| `{page}` | the page number |
| `{pages}` | the number of pages |
| `{bates}` | the Bates number |
| `{date}` | today's date |
| `{file}` | the file name |

The same recipes run on many files at once in [Batch processing](#batch), and you can save your own (for example your firm's standard footer).
