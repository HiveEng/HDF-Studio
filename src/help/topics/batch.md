---
title: Batch processing and recipes
section: Automate
order: 1
keywords: batch, recipe, automate, many files, bulk, page numbers, Bates, watermark, compress, flatten, OCR, redact, split, rotate, metadata, protect, steps, output name, preview
context: tab:automate
summary: Run the same steps on many PDFs at once, and save your own recipes.
---
# Batch processing and recipes

A **recipe** is a list of steps, such as *add page numbers, then compress*. Run it on one file or hundreds.

![How a batch runs: files go through each step of the recipe](d-batch.svg "plain")

![The Automate tab](ribbon-automate.png "wide")

## Running a batch

1. Click **Automate › Batch process**, or press [[Ctrl+B]].
2. Add files: **Add files**, **Add open tabs**, or drop PDFs on the list.
3. Pick a recipe. Its steps appear below, one per line, and you can edit them.
4. Set the **output name**: `{name}` is the original name, `{part}` the part number when splitting, `{date}` today's date.
5. Click **Preview first file** to check the result on one file, then **Run on all files** and choose an output folder.

![The Batch window](batch.png "wide")

To run a recipe on just the open document, use **Run on this file**.

## Ready-made recipes

| Recipe | Does |
|---|---|
| Add page numbers (Page X of Y) | Bottom-centre page numbers |
| Bates number (bottom right) | Bates numbers that continue across files |
| Watermark DRAFT / CONFIDENTIAL | Diagonal watermark |
| Compress (max) | Smaller files |
| Scrub metadata | Removes author, title and other properties |
| Flatten forms and comments | Locks form values and markups into the page |
| Remove first page | Deletes page 1 (for example a cover sheet) |
| Split into single pages | One file per page |
| Rotate all pages 90° | |
| Redact emails and phone numbers | Finds and permanently removes them, then removes hidden data |
| Remove hidden data | Metadata, JavaScript and attachments |
| Make scans searchable (OCR) | Recognizes text on pages without it |
| Clean up scans, then OCR | Straightens, removes specks and blank pages, then OCR |
| Make accessible | Tags for screen readers |
| OCR scans, then tag for accessibility | Both |

## Steps you can use

| Step | Example line |
|---|---|
| Rotate pages | `rotate degrees=90 pages=all` |
| Delete pages / keep only pages | `delete pages=1` / `keep pages="1-3,5"` |
| Reverse page order | `reverse` |
| Stamp text (header, footer, page numbers, Bates, watermark) | `stamp text="Page {page} of {pages}" position=bottom-center fontSize=10` |
| Set or scrub metadata | `metadata title="My title" author="Me"` |
| Password-protect / remove password | `protect ownerPassword=… allowPrint=true` / `unprotect password=…` |
| Flatten | `flatten` |
| Compress | `compress level=max` |
| Split | `split every=1` |
| Redact | `redact pattern=email` (also phone, ssn, card, date, money, or text and regex) |
| Remove hidden data | `sanitize removeComments=false` |
| OCR | `ocr pages=scanned` |
| Clean up scans | `clean straighten=true despeckle=true removeBlank=true` |
| Tag for accessibility | `tag lang=en-US` |

Stamp text can use `{page}`, `{pages}`, `{file}`, `{date}` and `{bates}`. OCR and cleanup always run before the other steps.

## Saving your own recipe

Edit the steps, click **Save** and give the recipe a name. It appears in the recipe list, in **Run on this file** and in [watch folders](#watch-folders). **Delete** removes a saved recipe.
