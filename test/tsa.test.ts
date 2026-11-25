import { test } from "node:test";
import assert from "node:assert/strict";
import forge from "node-forge";
import { signPdf, verifySignatures, makeSelfSignedP12 } from "../src/engine/digisign";
import { timestampRequest, embedTimestamp, tokenFromResponse } from "../src/engine/tsa";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";

const asn1 = forge.asn1;
const p12 = makeSelfSignedP12("Sean Test", "pw");

/** A tiny RFC 3161 timestamp authority, enough to answer one request. */
function mockTsa(name = "Test TSA", at = new Date("2026-03-01T10:00:00Z")) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "0a1b";
  cert.validity.notBefore = new Date(Date.now() - 86400_000);
  cert.validity.notAfter = new Date(Date.now() + 86400_000);
  cert.setSubject([{ name: "commonName", value: name }]);
  cert.setIssuer([{ name: "commonName", value: name }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return (tsq: Uint8Array, opts: { status?: number; wrongImprint?: boolean } = {}): Uint8Array => {
    const req = asn1.fromDer(forge.util.binary.raw.encode(tsq)).value as forge.asn1.Asn1[];
    const imprint = req[1];
    if (opts.wrongImprint) ((imprint.value as forge.asn1.Asn1[])[1]).value = "x".repeat(32);
    const int = (n: number) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(n).getBytes());
    const tst = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      int(1),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer("1.2.3.4.1").getBytes()),
      imprint,
      int(42),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.GENERALIZEDTIME, false, asn1.dateToGeneralizedTime(at)),
    ]);
    const tstDer = asn1.toDer(tst).getBytes();
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(tstDer);
    (p7 as unknown as { contentInfo: forge.asn1.Asn1 }).contentInfo = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer("1.2.840.113549.1.9.16.1.4").getBytes()),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, tstDer)]),
    ]);
    p7.addCertificate(cert);
    p7.addSigner({
      key: keys.privateKey,
      certificate: cert,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: "1.2.840.113549.1.9.16.1.4" }, { type: forge.pki.oids.messageDigest }],
    });
    p7.sign();
    const status = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [int(opts.status ?? 0)]);
    const parts = [status];
    if ((opts.status ?? 0) <= 1) parts.push(p7.toAsn1());
    const resp = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, parts);
    return Uint8Array.from(asn1.toDer(resp).getBytes(), (c) => c.charCodeAt(0));
  };
}

test("timestamp: request, embed, verify; signature stays intact and reports the TSA time", () => {
  const tsa = mockTsa();
  const signed = signPdf(makeSamplePdf(1), { p12, password: "pw", reason: "Approved", timestamp: true });
  const stamped = embedTimestamp(signed, tsa(timestampRequest(signed)));
  assert.equal(stamped.length, signed.length, "fits in the placeholder");
  const [c] = verifySignatures(stamped);
  assert.equal(c.intact, true, c.status);
  assert.equal(c.coversWholeFile, true);
  assert.equal(c.timestamp?.authority, "Test TSA");
  assert.equal(c.timestamp?.imprintMatches, true);
  assert.equal(c.timestamp?.tokenSignatureValid, true);
  assert.equal(c.signedAt?.toISOString(), "2026-03-01T10:00:00.000Z");
  assert.match(c.status, /Timestamped by Test TSA on 2026-03-01 10:00 UTC/);
  // Without a timestamp nothing changes.
  assert.equal(verifySignatures(signed)[0].timestamp ?? null, null);
});

test("timestamp: refused requests, tokens for another signature, and a second signature", () => {
  const tsa = mockTsa();
  const signed = signPdf(makeSamplePdf(1), { p12, password: "pw", timestamp: true });
  assert.throws(() => tokenFromResponse(tsa(timestampRequest(signed), { status: 2 })), /refused/);
  assert.throws(() => embedTimestamp(signed, tsa(timestampRequest(signed), { wrongImprint: true })), /doesn't match/);
  const stamped = embedTimestamp(signed, tsa(timestampRequest(signed)));
  const twice = signPdf(stamped, { p12, password: "pw", timestamp: true });
  const both = embedTimestamp(twice, tsa(timestampRequest(twice)));
  const checks = verifySignatures(both);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.intact && c.timestamp?.tokenSignatureValid), checks.map((c) => c.status).join(" | "));
});

test("engine: sign with timestamp request, then add the response", () => {
  const tsa = mockTsa("Engine TSA");
  const e = new Engine();
  const d = e.open(makeSamplePdf(1), "a.pdf");
  const r = e.signDigital(d.id, { p12, password: "pw", timestamp: true });
  assert.ok(r.tsq && r.tsq.length > 40);
  const t = e.addTimestamp(d.id, r.data, tsa(r.tsq!));
  const [c] = e.verifySignatures(d.id);
  assert.equal(c.timestamp?.authority, "Engine TSA");
  assert.equal(c.intact, true);
  assert.equal(t.data.length, r.data.length);
});
