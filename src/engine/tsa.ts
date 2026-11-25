// RFC 3161 trusted timestamps for PDF signatures. A timestamp proves the signature existed at a
// given time, so it stays valid after the signing certificate expires (PAdES B-T).
// Network access is left to the caller: build a request here, send it with whatever HTTP the
// platform has (Tauri command or Node fetch), then embed the response.
import forge from "node-forge";

const asn1 = forge.asn1;
const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const OID_TIMESTAMP_TOKEN = "1.2.840.113549.1.9.16.2.14";
const DIGESTS: Record<string, () => forge.md.MessageDigest> = {
  [forge.pki.oids.sha1]: () => forge.md.sha1.create(),
  [forge.pki.oids.sha256]: () => forge.md.sha256.create(),
  [forge.pki.oids.sha384]: () => forge.md.sha384.create(),
  [forge.pki.oids.sha512]: () => forge.md.sha512.create(),
};

export { TSA_SERVERS } from "./tsa-servers";

const bin = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return s;
};
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const seq = (v: forge.asn1.Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, v);
const oid = (o: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(o).getBytes());

// ---------- locating the CMS in a signed PDF ----------

/** Byte span of the last signature's /Contents hex string (between < and >). */
function lastContents(pdf: Uint8Array): { start: number; end: number } {
  const text = new TextDecoder("latin1").decode(pdf);
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let last: RegExpExecArray | null = null;
  for (let m; (m = re.exec(text)); ) last = m;
  if (!last) throw new Error("This file has no signature to timestamp");
  const [a, b, c] = last.slice(1, 4).map(Number);
  if (pdf[a + b] !== 0x3c || pdf[c - 1] !== 0x3e) throw new Error("Unexpected signature layout");
  return { start: a + b + 1, end: c - 1 };
}

function readCms(pdf: Uint8Array) {
  const span = lastContents(pdf);
  const hex = new TextDecoder("latin1").decode(pdf.subarray(span.start, span.end));
  const cms = asn1.fromDer(forge.util.hexToBytes(hex), { parseAllBytes: false } as never);
  const signedData = (cms.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[];
  const sd = signedData[0].value as forge.asn1.Asn1[];
  const signerInfos = sd[sd.length - 1].value as forge.asn1.Asn1[];
  const si = signerInfos[0].value as forge.asn1.Asn1[];
  let sigIndex = -1;
  si.forEach((n, i) => n.tagClass === asn1.Class.UNIVERSAL && n.type === asn1.Type.OCTETSTRING && (sigIndex = i));
  if (sigIndex < 0) throw new Error("Signature value not found");
  return { span, cms, si, signature: si[sigIndex].value as string };
}

// ---------- request / response ----------

/** Build a TimeStampReq for the last signature in the PDF. */
export function timestampRequest(signedPdf: Uint8Array): Uint8Array {
  const { signature } = readCms(signedPdf);
  const md = forge.md.sha256.create();
  md.update(signature);
  const nonce = forge.util.bytesToHex(forge.random.getBytesSync(8)).replace(/^[89a-f]/, "1");
  const req = seq([
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(1).getBytes()),
    seq([seq([oid(forge.pki.oids.sha256), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "")]), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, md.digest().getBytes())]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, forge.util.hexToBytes(nonce)),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
  ]);
  return bytes(asn1.toDer(req).getBytes());
}

/** Pull the TimeStampToken out of a TimeStampResp, or explain why the server refused. */
export function tokenFromResponse(resp: Uint8Array): forge.asn1.Asn1 {
  let r: forge.asn1.Asn1;
  try {
    r = asn1.fromDer(bin(resp), { parseAllBytes: false } as never);
  } catch {
    throw new Error("The timestamp server sent an unreadable answer");
  }
  const parts = r.value as forge.asn1.Asn1[];
  const status = (parts[0].value as forge.asn1.Asn1[])[0];
  const code = asn1.derToInteger(status.value as string);
  if (code !== 0 && code !== 1) throw new Error(`The timestamp server refused the request (status ${code})`);
  if (!parts[1]) throw new Error("The timestamp server sent no token");
  return parts[1];
}

/**
 * Put a timestamp token into the last signature of the PDF. The signature's /Contents is
 * outside the signed byte range, so this doesn't disturb the signature itself.
 */
export function embedTimestamp(signedPdf: Uint8Array, response: Uint8Array): Uint8Array {
  const token = tokenFromResponse(response);
  const { span, cms, si } = readCms(signedPdf);
  // Check the token is for this signature before we embed it.
  const info = describeToken(token, (readCms(signedPdf).signature));
  if (!info.imprintMatches) throw new Error("The timestamp doesn't match this signature");
  const attr = seq([oid(OID_TIMESTAMP_TOKEN), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [token])]);
  const last = si[si.length - 1];
  if (last.tagClass === asn1.Class.CONTEXT_SPECIFIC && last.type === 1) (last.value as forge.asn1.Asn1[]).push(attr);
  else si.push(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [attr]));
  const hex = forge.util.bytesToHex(asn1.toDer(cms).getBytes()).toUpperCase();
  const room = span.end - span.start;
  if (hex.length > room) throw new Error("Not enough room in the signature for the timestamp. Sign again with timestamping turned on.");
  const out = signedPdf.slice();
  const padded = hex.padEnd(room, "0");
  for (let i = 0; i < room; i++) out[span.start + i] = padded.charCodeAt(i);
  return out;
}

// ---------- reading a timestamp back ----------

export interface TimestampInfo {
  time: Date;
  authority: string;
  /** The token's hash matches the signature it is attached to. */
  imprintMatches: boolean;
  /** The timestamp authority's own signature over the token checks out. */
  tokenSignatureValid: boolean;
}

function describeToken(token: forge.asn1.Asn1, signatureValue: string): TimestampInfo {
  const sd = ((token.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  const encap = sd[2].value as forge.asn1.Asn1[];
  if (asn1.derToOid(encap[0].value as string) !== OID_TST_INFO) throw new Error("Not a timestamp token");
  let tstDer = (encap[1].value as forge.asn1.Asn1[])[0].value as string | forge.asn1.Asn1[];
  if (Array.isArray(tstDer)) tstDer = tstDer.map((p) => p.value as string).join(""); // constructed OCTET STRING
  const tst = asn1.fromDer(tstDer).value as forge.asn1.Asn1[];
  const imprint = tst[2].value as forge.asn1.Asn1[];
  const algo = asn1.derToOid((imprint[0].value as forge.asn1.Asn1[])[0].value as string);
  const mdFor = DIGESTS[algo];
  let imprintMatches = false;
  if (mdFor) {
    const md = mdFor();
    md.update(signatureValue);
    imprintMatches = md.digest().getBytes() === imprint[1].value;
  }
  const genTime = tst[4];
  const time = asn1.generalizedTimeToDate(genTime.value as string);

  // Certificates and the TSA's signer info.
  let authority = "Unknown authority";
  let tokenSignatureValid = false;
  try {
    const certsNode = sd.find((n) => n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 0);
    const certs = ((certsNode?.value as forge.asn1.Asn1[]) ?? []).map((c) => {
      try {
        return forge.pki.certificateFromAsn1(c);
      } catch {
        return null;
      }
    }).filter((c): c is forge.pki.Certificate => !!c);
    const si = ((sd[sd.length - 1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[]);
    const sid = si[1].value as forge.asn1.Asn1[];
    const serial = Array.isArray(sid) && sid[1] ? forge.util.bytesToHex(sid[1].value as string).replace(/^0+/, "") : "";
    const cert = certs.find((c) => c.serialNumber.replace(/^0+/, "") === serial) ?? certs[0];
    if (cert) authority = (cert.subject.getField("CN")?.value as string) ?? (cert.subject.getField("O")?.value as string) ?? authority;
    const digestAlgo = asn1.derToOid((si[2].value as forge.asn1.Asn1[])[0].value as string);
    const signedAttrs = si.find((n) => n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 0);
    const sigValue = si.find((n, i) => i > 3 && n.tagClass === asn1.Class.UNIVERSAL && n.type === asn1.Type.OCTETSTRING);
    const md = DIGESTS[digestAlgo];
    if (cert && signedAttrs && sigValue && md) {
      let attrDigest: string | null = null;
      for (const a of signedAttrs.value as forge.asn1.Asn1[]) {
        const parts = a.value as forge.asn1.Asn1[];
        if (asn1.derToOid(parts[0].value as string) === forge.pki.oids.messageDigest) attrDigest = (parts[1].value as forge.asn1.Asn1[])[0].value as string;
      }
      const contentMd = md();
      contentMd.update(tstDer);
      const set = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, signedAttrs.value as forge.asn1.Asn1[]);
      const attrMd = md();
      attrMd.update(asn1.toDer(set).getBytes());
      tokenSignatureValid = attrDigest === contentMd.digest().getBytes() && (cert.publicKey as forge.pki.rsa.PublicKey).verify(attrMd.digest().getBytes(), sigValue.value as string);
    }
  } catch {
    /* leave as not verified */
  }
  return { time, authority, imprintMatches, tokenSignatureValid };
}

/** Timestamp attached to a parsed SignerInfo (from verification), if any. */
export function timestampOf(signerInfo: forge.asn1.Asn1[], signatureValue: string): TimestampInfo | null {
  const unsigned = signerInfo.find((n) => n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 1);
  if (!unsigned) return null;
  for (const a of unsigned.value as forge.asn1.Asn1[]) {
    const parts = a.value as forge.asn1.Asn1[];
    if (asn1.derToOid(parts[0].value as string) === OID_TIMESTAMP_TOKEN) return describeToken((parts[1].value as forge.asn1.Asn1[])[0], signatureValue);
  }
  return null;
}

/** Timestamp inside a signature's CMS blob (DER as a binary string), if any. */
export function timestampFromCms(der: string): TimestampInfo | null {
  const cms = asn1.fromDer(der, { parseAllBytes: false } as never);
  const sd = ((cms.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  const si = ((sd[sd.length - 1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[]);
  let sig = "";
  si.forEach((n) => n.tagClass === asn1.Class.UNIVERSAL && n.type === asn1.Type.OCTETSTRING && (sig = n.value as string));
  return timestampOf(si, sig);
}
