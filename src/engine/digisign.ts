// Certificate-based digital signatures (PAdES-basic / adbe.pkcs7.detached) and signature validation.
// MuPDF builds the signature field and placeholder; node-forge (BSD-3-Clause) does the cryptography,
// so this runs the same in the desktop app and in the command line tool.
import * as mupdf from "mupdf";
import forge from "node-forge";

const PLACEHOLDER_BYTES = 16384; // room for the CMS blob (certificate chain + signature)

export interface SignOptions {
  /** PKCS#12 (.pfx/.p12) file contents and its password. */
  p12: Uint8Array;
  password: string;
  /** Page and rectangle (page space: points, top-left origin) for the visible signature; omit rect for invisible. */
  page?: number;
  rect?: number[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Optional PNG of a handwritten signature to show inside the box. */
  image?: Uint8Array;
}

export interface Signer {
  name: string;
  email: string | null;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  selfSigned: boolean;
}

export function readP12(p12: Uint8Array, password: string): { key: forge.pki.PrivateKey; cert: forge.pki.Certificate; chain: forge.pki.Certificate[]; signer: Signer } {
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bin(p12)), password);
  } catch {
    throw new Error("Could not open the certificate file. Check the password.");
  }
  const keyBag = parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ?? parsed.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const certs = (parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert!).filter(Boolean);
  if (!keyBag?.key) throw new Error("The certificate file has no private key");
  // The signing certificate is the one whose public key matches the private key.
  const key = keyBag.key as forge.pki.rsa.PrivateKey;
  const cert = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n)) ?? certs[0];
  if (!cert) throw new Error("The certificate file has no certificate");
  return { key, cert, chain: certs.filter((c) => c !== cert), signer: signerOf(cert) };
}

function signerOf(cert: forge.pki.Certificate): Signer {
  const attr = (s: forge.pki.Certificate["subject"], n: string) => (s.getField(n)?.value as string | undefined) ?? null;
  return {
    name: attr(cert.subject, "CN") ?? attr(cert.subject, "O") ?? "Unknown",
    email: attr(cert.subject, "E") ?? (cert.subject.getField({ type: "1.2.840.113549.1.9.1" })?.value as string | undefined) ?? null,
    issuer: attr(cert.issuer, "CN") ?? attr(cert.issuer, "O") ?? "Unknown",
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    selfSigned: cert.issuer.hash === cert.subject.hash,
  };
}

const bin = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return s;
};
const pdfDate = (d: Date) => "D:" + d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";

export function signPdf(input: Uint8Array, o: SignOptions): Uint8Array {
  const { key, cert, chain, signer } = readP12(o.p12, o.password);
  const now = new Date();
  if (now > signer.validTo) throw new Error(`The certificate expired on ${signer.validTo.toDateString()}`);

  const doc = mupdf.Document.openDocument(input, "pdf").asPDF();
  if (!doc) throw new Error("Not a PDF");
  const hadSignatures = /\/ByteRange\s*\[/.test(new TextDecoder("latin1").decode(input));
  const pageIndex = o.page ?? 0;
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  const pageObj = page.getObject();

  // Signature value dictionary with fixed-width placeholders we patch after saving.
  const sig = doc.newDictionary();
  sig.put("Type", doc.newName("Sig"));
  sig.put("Filter", doc.newName("Adobe.PPKLite"));
  sig.put("SubFilter", doc.newName("adbe.pkcs7.detached"));
  sig.put("Name", doc.newString(signer.name));
  sig.put("M", doc.newString(pdfDate(now)));
  if (o.reason) sig.put("Reason", doc.newString(o.reason));
  if (o.location) sig.put("Location", doc.newString(o.location));
  if (o.contactInfo) sig.put("ContactInfo", doc.newString(o.contactInfo));
  const br = doc.newArray();
  for (const v of [0, 1111111111, 2222222222, 3333333333]) br.push(v);
  sig.put("ByteRange", br);
  sig.put("Contents", doc.newByteString(new Uint8Array(PLACEHOLDER_BYTES)));
  const sigRef = doc.addObject(sig);

  // Widget annotation / field.
  let rectUser = [0, 0, 0, 0];
  if (o.rect) {
    const inv = mupdf.Matrix.invert(page.getTransform());
    rectUser = mupdf.Rect.transform(o.rect as mupdf.Rect, inv) as number[];
  }
  const w = doc.newDictionary();
  w.put("Type", doc.newName("Annot"));
  w.put("Subtype", doc.newName("Widget"));
  w.put("FT", doc.newName("Sig"));
  w.put("T", doc.newString(`Signature${Date.now() % 100000}`));
  const r = doc.newArray();
  rectUser.forEach((v) => r.push(+v.toFixed(2)));
  w.put("Rect", r);
  w.put("F", o.rect ? 4 : 132); // print; or hidden+print for invisible
  w.put("P", pageObj);
  w.put("V", sigRef);
  if (o.rect) w.put("AP", appearance(doc, rectUser, signer, now, o));
  const wRef = doc.addObject(w);

  let annots = pageObj.get("Annots");
  if (annots.isNull()) {
    annots = doc.newArray();
    pageObj.put("Annots", annots);
  }
  annots.push(wRef);
  const root = doc.getTrailer().get("Root");
  let form = root.get("AcroForm");
  if (form.isNull()) {
    form = doc.newDictionary();
    root.put("AcroForm", form);
  }
  let fields = form.get("Fields");
  if (fields.isNull()) {
    fields = doc.newArray();
    form.put("Fields", fields);
  }
  fields.push(wRef);
  form.put("SigFlags", 3);
  page.destroy();

  // Incremental save keeps earlier signatures valid; otherwise a clean full save.
  const buf = doc.saveToBuffer(hadSignatures ? "incremental" : "garbage");
  const pdf = new Uint8Array(buf.asUint8Array());
  buf.destroy();
  doc.destroy();
  return fillSignature(pdf, key, cert, chain, now);
}

/** Visible signature box: optional handwritten image, then signer and date. */
function appearance(doc: mupdf.PDFDocument, rect: number[], s: Signer, when: Date, o: SignOptions): mupdf.PDFObject {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", font);
  res.put("Font", fonts);
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?");
  const lines = [`Digitally signed by ${s.name}`, `Date: ${when.toISOString().replace("T", " ").slice(0, 19)} UTC`, o.reason ? `Reason: ${o.reason}` : "", o.location ? `Location: ${o.location}` : ""].filter(Boolean);
  let ops = "";
  let textX = 4;
  if (o.image) {
    const img = doc.addImage(new mupdf.Image(o.image));
    const xo = doc.newDictionary();
    xo.put("Im1", img);
    res.put("XObject", xo);
    const iw = new DataView(o.image.buffer, o.image.byteOffset).getUint32(16), ih = new DataView(o.image.buffer, o.image.byteOffset).getUint32(20);
    const boxW = w * 0.45, sc = Math.min(boxW / iw, (h - 4) / ih);
    ops += `q ${(iw * sc).toFixed(2)} 0 0 ${(ih * sc).toFixed(2)} 2 ${((h - ih * sc) / 2).toFixed(2)} cm /Im1 Do Q\n`;
    textX = boxW + 8;
  }
  const size = Math.max(5, Math.min(9, (h - 6) / (lines.length * 1.25)));
  ops += `0.1 0.15 0.35 rg BT /F1 ${size.toFixed(2)} Tf ${textX} ${(h - size - 3).toFixed(2)} Td ${(size * 1.25).toFixed(2)} TL ` + lines.map((l) => `(${esc(l)}) Tj T*`).join(" ") + " ET";
  const stream = doc.addStream(ops, { Type: doc.newName("XObject"), Subtype: doc.newName("Form"), BBox: [0, 0, w, h], Resources: res } as never);
  const ap = doc.newDictionary();
  ap.put("N", stream);
  return ap;
}

/** Patch ByteRange, hash the covered bytes, and embed a detached CMS signature into the placeholder. */
function fillSignature(pdf: Uint8Array, key: forge.pki.PrivateKey, cert: forge.pki.Certificate, chain: forge.pki.Certificate[], when: Date): Uint8Array {
  const text = new TextDecoder("latin1").decode(pdf);
  const brAt = text.lastIndexOf("/ByteRange");
  if (brAt < 0) throw new Error("Signature placeholder not found");
  const brOpen = text.indexOf("[", brAt), brClose = text.indexOf("]", brAt);
  // The zero-filled hex string is our placeholder (earlier signatures are already filled in).
  const cStart = text.lastIndexOf("<" + "0".repeat(64));
  const cEnd = text.indexOf(">", cStart) + 1;
  if (cStart < 0 || cEnd <= cStart || cEnd - cStart - 2 < PLACEHOLDER_BYTES * 2) throw new Error("Signature contents placeholder not found");
  const range = [0, cStart, cEnd, pdf.length - cEnd];
  let brText = range.join(" ");
  const room = brClose - brOpen - 1;
  if (brText.length > room) throw new Error("ByteRange placeholder too small");
  brText = brText.padEnd(room, " ");
  const out = pdf.slice();
  for (let i = 0; i < room; i++) out[brOpen + 1 + i] = brText.charCodeAt(i);

  const signed = new Uint8Array(range[1] + range[3]);
  signed.set(out.subarray(0, range[1]), 0);
  signed.set(out.subarray(range[2]), range[1]);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(bin(signed));
  p7.addCertificate(cert);
  for (const c of chain) p7.addCertificate(c);
  p7.addSigner({
    key: key as forge.pki.rsa.PrivateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: when as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const hex = forge.util.bytesToHex(der).toUpperCase();
  if (hex.length > cEnd - cStart - 2) throw new Error("Signature too large for the placeholder");
  const padded = hex.padEnd(cEnd - cStart - 2, "0");
  for (let i = 0; i < padded.length; i++) out[cStart + 1 + i] = padded.charCodeAt(i);
  return out;
}

// ---------- Validation ----------

export interface SignatureCheck {
  field: string;
  signer: Signer | null;
  signedAt: Date | null;
  reason: string | null;
  /** The signed bytes are unchanged and the cryptographic signature matches the certificate. */
  intact: boolean;
  /** The signature covers the whole file (no changes were appended after signing). */
  coversWholeFile: boolean;
  /** Human summary. */
  status: string;
  error?: string;
}

/** Check every signature in a PDF: integrity, coverage and signer details (trust chains are reported, not enforced). */
export function verifySignatures(pdf: Uint8Array): SignatureCheck[] {
  const text = new TextDecoder("latin1").decode(pdf);
  const out: SignatureCheck[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    n++;
    const [a, b, c, d] = m.slice(1).map(Number);
    const check: SignatureCheck = { field: `Signature ${n}`, signer: null, signedAt: null, reason: null, intact: false, coversWholeFile: c + d === pdf.length, status: "" };
    try {
      // The placeholder is zero-padded after the DER; parse only the leading ASN.1 structure.
      const der = forge.util.hexToBytes(text.slice(a + b + 1, c - 1));
      const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der, { parseAllBytes: false } as never)) as forge.pkcs7.PkcsSignedData & { rawCapture: Record<string, unknown>; certificates: forge.pki.Certificate[] };
      const cap = msg.rawCapture as { authenticatedAttributes?: forge.asn1.Asn1[]; signature: string; digestAlgorithm: string };
      const cert = msg.certificates[0];
      check.signer = signerOf(cert);
      const reasonMatch = /\/Reason\s*\(([^)]*)\)/.exec(text.slice(Math.max(0, m.index - 2000), m.index + 40000));
      check.reason = reasonMatch?.[1] ?? null;
      // Hash the raw bytes (the decoded text maps some bytes to other code points).
      const signedBytes = bin(pdf.subarray(a, a + b)) + bin(pdf.subarray(c, c + d));
      const md = forge.md.sha256.create();
      md.update(signedBytes);
      const digest = md.digest().getBytes();
      const attrs = cap.authenticatedAttributes ?? [];
      let attrDigest: string | null = null;
      for (const attr of attrs) {
        const oid = forge.asn1.derToOid((attr.value as forge.asn1.Asn1[])[0].value as string);
        const val = ((attr.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0];
        if (oid === forge.pki.oids.messageDigest) attrDigest = val.value as string;
        if (oid === forge.pki.oids.signingTime) check.signedAt = val.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(val.value as string) : forge.asn1.generalizedTimeToDate(val.value as string);
      }
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      const attrMd = forge.md.sha256.create();
      attrMd.update(forge.asn1.toDer(set).getBytes());
      const sigOk = (cert.publicKey as forge.pki.rsa.PublicKey).verify(attrMd.digest().getBytes(), cap.signature);
      check.intact = attrDigest === digest && sigOk;
      check.status = !check.intact
        ? "INVALID: the document was changed after signing, or the signature is corrupt"
        : check.coversWholeFile
          ? `Valid: signed by ${check.signer.name}${check.signer.selfSigned ? " (self-signed certificate, identity not verified by a third party)" : ` (issued by ${check.signer.issuer})`}`
          : `Valid for the signed revision; the file was changed after this signature (e.g. later signatures or comments)`;
    } catch (e) {
      check.error = (e as Error).message;
      check.status = `Could not verify: ${check.error}`;
    }
    out.push(check);
  }
  return out;
}

/** Make a self-signed certificate (.pfx) for testing or internal use. */
export function makeSelfSignedP12(name: string, password: string, email?: string, years = 3): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + years * 365 * 86400_000);
  const attrs: forge.pki.CertificateField[] = [{ name: "commonName", value: name }];
  if (email) attrs.push({ name: "emailAddress", value: email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true, nonRepudiation: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "aes256" });
  const der = forge.asn1.toDer(p12).getBytes();
  return Uint8Array.from(der, (c) => c.charCodeAt(0));
}
