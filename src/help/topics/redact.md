---
title: Redaction
section: Protect
order: 1
keywords: redact, redaction, black out, remove text, permanent, find and redact, email, phone number, social security, credit card, regex, regular expression, SHX, apply redactions, sanitize, privacy
context: tab:protect, tool:redact
summary: Mark text or areas, review them, then remove them permanently.
---
# Redaction

Redaction **removes** content for good: the text, pictures and line work under a redaction are deleted from the file, not just covered. It happens in three steps, so you can review before anything is removed.

![Mark, review, apply, save](d-redact.svg "plain")

![The Protect tab](ribbon-protect.png "wide")

## 1. Mark what to remove

**By hand:** click **Mark area** (or press [[D]]), then select text or drag a box around an area.

**By searching:** click **Find & redact** ([[Ctrl+Shift+R]]).

![Find and mark for redaction](find-redact.png "small")

| Find | Marks |
|---|---|
| Text | A word or phrase you type |
| Email addresses, Phone numbers, US Social Security numbers, Credit card numbers, Dates, Money amounts | Built-in patterns: leave the text box empty |
| Regular expression | A pattern you type, such as `ACME-\d{6}` |

Choose the **pages** and whether to **match case**.

On drawings, {{app}} also searches the hidden *AutoCAD SHX Text* comments that AutoCAD places over SHX-font lettering, so drawing text is found even though it's drawn as lines. If nothing is found on pages with no searchable text, {{app}} offers to recognize the text (OCR) and search again.

## 2. Review

Marks show as outlined boxes and are listed in the **Comments** panel. Delete any mark you don't want. Nothing has been removed yet.

![Matches marked for redaction](redact-marked.png "wide")

## 3. Apply and save

Click **Apply** on the Protect tab, or the red **Apply N redactions** button at the top right. Everything under the marks is removed and covered with black boxes.

Then **save**. Until you save, [[Ctrl+Z]] can still bring the content back; after saving it's gone from the file.

> **Important:** Redaction removes what's under the box. To also remove hidden information such as the author, metadata, scripts and attachments, use **Remove hidden data**. See [Passwords and hidden data](#security).
