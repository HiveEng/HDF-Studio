import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/core";
import { startReviewServer } from "../src/review/server";
import { ReviewSync, createReview, downloadReview, parseReviewLink, formatReviewLink } from "../src/review/client";
import { makeSamplePdf } from "./fixtures";

test("review links parse in every form", () => {
  assert.deepEqual(parseReviewLink("http://srv:8787/r/abc123"), { server: "http://srv:8787", id: "abc123" });
  assert.deepEqual(parseReviewLink("https://reviews.hiveng.ca/r/Xy9?x=1"), { server: "https://reviews.hiveng.ca", id: "Xy9" });
  assert.deepEqual(parseReviewLink("http://srv:8787#abc"), { server: "http://srv:8787", id: "abc" });
  assert.equal(parseReviewLink("not a link"), null);
  assert.equal(formatReviewLink({ server: "http://s", id: "q" }), "http://s/r/q");
});

test("two reviewers: comments, replies, status, edits and deletes flow both ways without echoes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdf-review-"));
  const server = await startReviewServer({ port: 0, host: "127.0.0.1", dataDir: dir, token: "s3cret" });
  try {
    const token = () => "s3cret";
    // Alice starts the review.
    const a = new Engine();
    const ad = a.open(makeSamplePdf(2), "plan.pdf").id;
    const link = await createReview(server.url, "plan.pdf", a.save(ad), "s3cret");
    await assert.rejects(createReview(server.url, "x.pdf", a.save(ad), "wrong"), /access token/);
    // Bob joins.
    const b = new Engine();
    const dl = await downloadReview(link, "s3cret");
    assert.equal(dl.name, "plan.pdf");
    const bd = b.open(dl.pdf, dl.name).id;

    const sa = new ReviewSync(a, ad, link, { author: () => "Alice", token });
    const sb = new ReviewSync(b, bd, link, { author: () => "Bob", token });
    await sa.sync();
    await sb.sync();

    const k = a.addAnnotation(ad, 0, { type: "Square", rect: [100, 100, 200, 150], contents: "Check this figure" }, "Alice");
    assert.equal((await sa.sync()).pushed, 1);
    assert.equal((await sb.sync()).pulled, 1);
    const bobView = b.allAnnotations(bd);
    assert.equal(bobView.length, 1);
    assert.equal(bobView[0].contents, "Check this figure");
    assert.equal(bobView[0].author, "Alice");

    // Bob replies and accepts; Alice sees the thread.
    b.addReply(bd, 0, bobView[0].key, "Fixed in v2", "Bob");
    b.addReply(bd, 0, bobView[0].key, "Bob set status to Accepted", "Bob", "Accepted");
    assert.equal((await sb.sync()).pushed, 2);
    await sa.sync();
    const aliceView = a.allAnnotations(ad);
    const parent = aliceView.find((x) => x.contents === "Check this figure")!;
    assert.equal(aliceView.filter((x) => x.inReplyTo === parent.key).length, 2);
    assert.equal(aliceView.find((x) => x.state)!.state, "Accepted");

    // Nothing bounces back and forth.
    assert.deepEqual([(await sa.sync()).pushed, (await sb.sync()).pushed, (await sa.sync()).pushed], [0, 0, 0]);

    // Alice edits her comment: Bob gets the new text, replies still attached.
    a.updateAnnotation(ad, 0, parent.key, { contents: "Check this figure and table" });
    await sa.sync();
    await sb.sync();
    const bp = b.allAnnotations(bd).find((x) => x.type === "Square")!;
    assert.equal(bp.contents, "Check this figure and table");
    assert.equal(b.allAnnotations(bd).filter((x) => x.inReplyTo === bp.key).length, 2, "replies re-linked");

    // Alice deletes her comment; it disappears for Bob.
    a.deleteAnnotation(ad, 0, a.allAnnotations(ad).find((x) => x.type === "Square")!.key);
    await sa.sync();
    await sb.sync();
    assert.equal(b.allAnnotations(bd).filter((x) => x.type === "Square").length, 0);

    // A late joiner gets everything that's left.
    const c = new Engine();
    const cd = c.open((await downloadReview(link, "s3cret")).pdf, "plan.pdf").id;
    const sc = new ReviewSync(c, cd, link, { author: () => "Cy", token });
    const r = await sc.sync();
    assert.equal(c.allAnnotations(cd).length, a.allAnnotations(ad).length);
    assert.deepEqual(r.reviewers, ["Bob"]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server keeps reviews across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdf-review-"));
  let server = await startReviewServer({ port: 0, host: "127.0.0.1", dataDir: dir });
  const e = new Engine();
  const id = e.open(makeSamplePdf(1), "a.pdf").id;
  const link = await createReview(server.url, "a.pdf", e.save(id));
  e.addAnnotation(id, 0, { type: "Text", at: [50, 50], contents: "Hello" }, "Ann");
  await new ReviewSync(e, id, link, { author: () => "Ann" }).sync();
  server.close();
  server = await startReviewServer({ port: 0, host: "127.0.0.1", dataDir: dir });
  try {
    const moved = { ...link, server: server.url };
    const f = new Engine();
    const fid = f.open((await downloadReview(moved)).pdf, "a.pdf").id;
    await new ReviewSync(f, fid, moved, { author: () => "Bo" }).sync();
    assert.equal(f.allAnnotations(fid)[0].contents, "Hello");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Microsoft sign-in: only @hiveng.ca accounts, names come from the account, no deleting others' comments", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  const tenant = "11111111-2222-3333-4444-555555555555", clientId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const jwt = (claims: Record<string, unknown>) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
    const body = enc({ iss: `https://login.microsoftonline.com/${tenant}/v2.0`, aud: clientId, exp: Date.now() / 1000 + 3600, ...claims });
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  const sean = jwt({ preferred_username: "Sean@HivEng.ca", name: "Sean O'Brien" });
  const dana = jwt({ preferred_username: "dana@hiveng.ca", name: "Dana Lee" });
  const dir = mkdtempSync(join(tmpdir(), "hdf-review-"));
  const server = await startReviewServer({ port: 0, host: "127.0.0.1", dataDir: dir, microsoft: { kind: "microsoft", tenant, clientId, domains: ["hiveng.ca"], jwks: async () => [jwk as never] } });
  try {
    const cfg = await (await fetch(`${server.url}/api/config`)).json();
    assert.deepEqual(cfg, { auth: "microsoft", tenant, clientId, domains: ["hiveng.ca"] });
    const e = new Engine();
    const id = e.open(makeSamplePdf(1), "a.pdf").id;
    await assert.rejects(createReview(server.url, "a.pdf", e.save(id), jwt({ preferred_username: "x@gmail.com" })), /Only @hiveng\.ca/);
    await assert.rejects(createReview(server.url, "a.pdf", e.save(id), jwt({ preferred_username: "x@hiveng.ca", exp: 1 })), /expired/);
    await assert.rejects(createReview(server.url, "a.pdf", e.save(id), jwt({ preferred_username: "x@hiveng.ca", aud: "other" })), /another app/);
    await assert.rejects(createReview(server.url, "a.pdf", e.save(id), sean.slice(0, -4) + "AAAA"), /not valid/);
    await assert.rejects(createReview(server.url, "a.pdf", e.save(id), null), /sign in/);
    const link = await createReview(server.url, "a.pdf", e.save(id), sean);

    e.addAnnotation(id, 0, { type: "Text", at: [50, 50], contents: "Sean's note" }, "typed name");
    const ss = new ReviewSync(e, id, link, { author: () => "Sean O'Brien", token: () => sean });
    await ss.sync();
    const items = (await (await fetch(`${server.url}/api/reviews/${link.id}/comments`, { headers: { Authorization: `Bearer ${dana}` } })).json()).items;
    assert.equal(items[0].author, "Sean O'Brien", "author comes from the Microsoft account");
    // Dana tries to delete Sean's note: refused.
    await fetch(`${server.url}/api/reviews/${link.id}/comments`, { method: "POST", headers: { Authorization: `Bearer ${dana}`, "Content-Type": "application/json" }, body: JSON.stringify({ deletes: [items[0].name] }) });
    const after = (await (await fetch(`${server.url}/api/reviews/${link.id}/comments`, { headers: { Authorization: `Bearer ${dana}` } })).json()).items;
    assert.equal(after[0].deleted, false);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
