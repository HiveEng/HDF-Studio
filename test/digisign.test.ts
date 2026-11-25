import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { signPdf, verifySignatures, makeSelfSignedP12, readP12 } from "../src/engine/digisign";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";

const p12 = makeSelfSignedP12("Sean Test", "pw", "sean@example.com");

test("sign, validate, detect tampering, second signature keeps the first valid", () => {
  assert.equal(readP12(p12, "pw").signer.name, "Sean Test");
  assert.throws(() => readP12(p12, "wrong"), /password/);

  const signed = signPdf(makeSamplePdf(2), { p12, password: "pw", page: 0, rect: [350, 650, 560, 710], reason: "Approved", location: "Dublin" });
  let checks = verifySignatures(signed);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].intact, true, checks[0].status);
  assert.equal(checks[0].coversWholeFile, true);
  assert.equal(checks[0].signer?.name, "Sean Test");
  assert.equal(checks[0].reason, "Approved");
  assert.ok(checks[0].signedAt instanceof Date);

  // still a normal PDF; the signature widget is there and the page renders
  const e = new Engine();
  const d = e.open(signed);
  assert.equal(d.pageCount, 2);
  assert.ok(e.fields(d.id).some((f) => f.type === "signature"));
  assert.ok(e.render(d.id, 0, 0.5).width > 0);

  // tamper with one signed byte (inside the page text) -> invalid
  const t = signed.slice();
  const idx = new TextDecoder("latin1").decode(t).indexOf("%PDF") + 5;
  t[idx] = t[idx] === 0x37 ? 0x36 : 0x37;
  assert.equal(verifySignatures(t)[0].intact, false);

  // second signature (incremental): both valid; first no longer covers the whole file
  const twice = signPdf(signed, { p12, password: "pw", page: 1, rect: [350, 650, 560, 710], reason: "Countersigned" });
  checks = verifySignatures(twice);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.intact), checks.map((c) => c.status).join(" | "));
  assert.deepEqual(checks.map((c) => c.coversWholeFile), [false, true]);
});

test("OpenSSL accepts the CMS signature", () => {
  const signed = signPdf(makeSamplePdf(1), { p12, password: "pw" }); // invisible signature
  const text = new TextDecoder("latin1").decode(signed);
  const [a, b, c, d] = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(text)!.slice(1).map(Number);
  mkdirSync("scratch/ossl", { recursive: true });
  const hex = text.slice(a + b + 1, c - 1).replace(/(00)+$/, "");
  writeFileSync("scratch/ossl/sig.der", Buffer.from(hex, "hex"));
  writeFileSync("scratch/ossl/content.bin", Buffer.concat([signed.subarray(a, a + b), signed.subarray(c, c + d)]));
  const out = execFileSync("openssl", ["cms", "-verify", "-inform", "DER", "-in", "scratch/ossl/sig.der", "-content", "scratch/ossl/content.bin", "-binary", "-noverify", "-out", "/dev/null"], { stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(out !== undefined);
});
