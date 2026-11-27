---
title: Digital IDs and certifying
section: Fill and sign
order: 2
keywords: digital signature, certificate, certify, pfx, p12, digital ID, validate, verify signature, timestamp, self-signed, trusted, PKI, seal
summary: Sign with a certificate, add a trusted timestamp, and check others' signatures.
---
# Digital IDs and certifying

A **digital signature** uses a certificate (a digital ID) to prove who signed and that the document hasn't been changed since. Anyone can check it in {{app}}, Acrobat or other PDF readers.

## Signing with a certificate

1. Click **Fill & Sign › Certify**.
2. Pick your certificate file (`.pfx` or `.p12`) and type its password.
3. Optionally add a **reason** (for example *Approved*) and **location**.
4. **Signature box:** *Visible* (then click on the page to place it) or *Invisible* (shown only in the signature panel).
5. **Include my handwritten signature** to show your signature image in the box.
6. **Trusted timestamp:** pick a free timestamp server. It proves when you signed, so the signature stays valid after your certificate expires. It needs internet.

Save the file afterwards. Any later change to the file shows up when the signature is validated.

## Checking signatures

**Fill & Sign › Validate** lists every signature in the document: who signed, when, whether the document has changed since, and whether the certificate is trusted.

## Making a digital ID

**New digital ID** creates a self-signed certificate (a `.pfx` file protected by your password). It proves the file wasn't changed after signing, but not who you are. For signatures that others must trust, use a certificate issued by your organization or a certificate authority.
