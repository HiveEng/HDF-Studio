---
title: Troubleshooting and questions
section: Reference
order: 3
keywords: problem, not working, error, FAQ, help, can't search, can't select text, slow, blurry, missing tool, measurement wrong, sign in fails, update, OneDrive, printing wrong size, LibreOffice, Ghostscript, reset
summary: Fixes for common problems and answers to common questions.
---
# Troubleshooting and questions

## Search, copy or highlight doesn't work on a page

The page is probably a scan or a CAD drawing whose lettering is drawn as lines. Run [OCR](#ocr) on it.

## I can't find a tool

Press [[Ctrl+K]] and type part of its name. On a narrow window the ribbon shows icons only; hover for names, or make the window wider.

## Ribbon buttons are greyed out

They need an open document. Open a PDF first.

## Measurements are wrong

- Check the scale: the status bar shows which scale each measurement used. See [Setting the scale](#scale).
- Sheets in one PDF can have different scales. Set the scale on **This page** for sheets that differ.
- If the sheet was printed or scanned at an unknown size, [calibrate](#scale/calibrate-from-a-known-dimension) from a long known dimension.
- Turn on snapping ([[F9]]) so points land exactly on line ends.

## My drawing printed at the wrong size

Choose **Actual size** in the Print dialog and paper that matches the sheet (for example 11x17). *Fit to paper* changes the scale. See [Printing](#open-save/printing).

## Dragging on the page draws a box instead of moving the view

With the Hand tool, dragging on empty space selects markups. Pan with the middle mouse button or by holding [[Space]]. See [Selecting](#selecting).

## A markup won't move

Clouds, shapes, lines and measurements stay where they're drawn: delete and redraw them, or undo. Text boxes, callouts, stamps, signatures and pictures can be dragged.

## Sign-in fails or keeps asking

Check your internet connection and that you're using your Hive Engineering Microsoft 365 account. {{app}} works offline for up to 30 days after a successful sign-in. See [Signing in](#signin).

## Open from 365 says it can't connect

You need to be signed in and online. The first time, Microsoft may need your permission or an administrator's. See [Microsoft 365](#m365).

## Word, Excel or PowerPoint files won't convert

Office files are converted with LibreOffice. Install LibreOffice (free) on the computer and try again.

## Save as PDF/A says it needs Ghostscript

Install Ghostscript (free) from ghostscript.com, then try again.

## Windows says "Windows protected your PC" when installing

The installer isn't code-signed yet. Click **More info**, then **Run anyway**.

## Something went wrong after a change

Press [[Ctrl+Z]]. Almost everything can be undone until you close the file, and redactions until you save.

## Reporting a problem

Note what you did, what you expected and what happened, the version (**Settings › About**), and if you can, the file. Send it to whoever looks after {{app}} at Hive Engineering.
