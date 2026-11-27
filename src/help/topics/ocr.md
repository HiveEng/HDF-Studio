---
title: Recognizing text (OCR) and cleaning scans
section: Convert
order: 1
keywords: OCR, optical character recognition, scan, scanned, searchable, copy text, recognize text, language, French, straighten, deskew, despeckle, specks, blank pages, clean up scans, SHX, image only
context: tab:convert
summary: Make scanned pages searchable and copyable, and tidy them up first.
---
# Recognizing text (OCR) and cleaning scans

A scanned page is a picture: you can't search it, copy from it or highlight its words. **OCR** reads the picture and adds an invisible text layer exactly over the words. The page looks the same, but now it's searchable and copyable.

![OCR adds an invisible, searchable text layer over the scan](d-ocr.svg "plain")

## Recognizing text

1. Click **OCR / Recognize text** on the Home tab, **Convert › Recognize text**, or press [[Ctrl+Shift+O]].
2. **Pages:** pages without text (the usual choice), all pages, the current page, or a range.
3. **Language**, and an optional **second language** for documents that mix two. Languages other than the built-in ones download once.
4. **Clean up first:** straighten, remove specks and blank pages; straighten only; or no cleanup.
5. Click **Recognize**. Progress shows as it works, and you can stop it.

![Recognize text](ocr-dialog.png "small")

When it finishes, the status bar shows how many words were found. Search ([[Ctrl+F]]), copy and text markup now work. [[Ctrl+Z]] undoes.

OCR runs on this computer, so documents never leave it, and it works offline for the built-in languages.

> **Tip:** On CAD drawings whose lettering is drawn as lines (SHX fonts), OCR the pages to make the lettering searchable and redactable.

## Cleaning up scans

**Convert › Clean up** improves scans before OCR (and for reading):

| Option | Does |
|---|---|
| **Straighten crooked pages** | Rotates pages fed in at a slight angle so text lines are level |
| **Remove specks** | Removes dust and toner dots |
| **Delete blank pages** | Removes blank backs of double-sided scans and separator sheets |

Only pages without real text are changed, so pages that are already digital are left alone.

Set the usual OCR language in [Settings](#settings). To OCR many files, use the batch recipes *Make scans searchable (OCR)* or *Clean up scans, then OCR*; see [Batch processing](#batch).
