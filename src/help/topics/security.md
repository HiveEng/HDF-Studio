---
title: Passwords and hidden data
section: Protect
order: 2
keywords: password, protect, encrypt, AES-256, permissions, printing allowed, copying, remove password, unlock, hidden data, metadata, sanitize, scripts, JavaScript, attachments, privacy
summary: Lock a PDF with a password and permissions, and strip hidden information.
---
# Passwords and hidden data

## Protecting with a password

1. Click **Protect › Password**.
2. **Password to open** (optional): people need it to open the file.
3. **Permissions password** (required): needed to change the restrictions.
4. Choose what's allowed without the permissions password: **Printing**, **Copying text and images**, **Editing and page changes**, and **Comments and form filling**.
5. Save the file. Protection is applied when you save.

Files are encrypted with AES-256.

> **Important:** Keep the passwords somewhere safe. {{app}} can't recover a forgotten password to open.

## Removing a password

Open the file (with its password), click **Protect › Remove password**, and save.

## Removing hidden data

**Protect › Remove hidden data** strips information that isn't visible on the pages: metadata (author, title, software), JavaScript and embedded attachments. You can also remove all comments and markup. Use it before sending files outside the company.

The batch recipe *Remove hidden data* does the same for many files at once; see [Batch processing](#batch).
