import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph, GRAPH, SIMPLE_UPLOAD_MAX, CHUNK, type Fetcher } from "../src/cloud/graph";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

function fake(routes: (method: string, url: string, o: Parameters<Fetcher>[2]) => unknown) {
  const calls: { method: string; url: string; o: Parameters<Fetcher>[2] }[] = [];
  const f: Fetcher = async (method, url, o) => {
    calls.push({ method, url, o });
    const r = routes(method, url, o);
    if (r instanceof Error) throw r;
    return r instanceof Uint8Array ? r : enc(r);
  };
  return { f, calls };
}

test("graph: places, paging through folders, and download", async () => {
  const { f, calls } = fake((m, url) => {
    if (url.endsWith("/me/drive?$select=id,name")) return { id: "D1", name: "OneDrive" };
    if (url.includes("/me/followedSites")) return { value: [{ id: "S1", displayName: "Projects", webUrl: "https://hive.sharepoint.com/sites/projects" }] };
    if (url.includes("/items/root/children")) return { value: [{ id: "F1", name: "Drawings", folder: { childCount: 2 }, parentReference: { driveId: "D1" } }], "@odata.nextLink": `${GRAPH}/next` };
    if (url === `${GRAPH}/next`) return { value: [{ id: "I1", name: "S-201.pdf", file: {}, size: 1234, eTag: "e1", parentReference: { driveId: "D1", id: "root-id" } }] };
    if (url.endsWith("/items/I1/content")) return new Uint8Array([37, 80, 68, 70]);
    return new Error("HTTP 404: {}");
  });
  const g = new Graph(f, async () => "TOKEN");
  const places = await g.places();
  assert.deepEqual(places.map((p) => p.name), ["OneDrive", "Recent", "Shared with me", "Projects"]);
  const items = await g.children("D1");
  assert.deepEqual(items.map((i) => [i.name, i.folder]), [["Drawings", true], ["S-201.pdf", false]]);
  assert.equal(items[1].eTag, "e1");
  assert.equal(items[1].parentId, "root-id");
  assert.deepEqual([...(await g.download("D1", "I1"))], [37, 80, 68, 70]);
  assert.ok(calls.every((c) => c.o?.token === "TOKEN"));
});

test("graph: small save overwrites with If-Match; new files don't replace unless asked", async () => {
  const { f, calls } = fake((m, url) => ({ id: "I9", name: "x.pdf", eTag: "e2", parentReference: { driveId: "D1" } }));
  const g = new Graph(f, async () => "T");
  await g.upload({ driveId: "D1", itemId: "I1", eTag: "e1", data: new Uint8Array(10) });
  assert.equal(calls[0].method, "PUT");
  assert.ok(calls[0].url.endsWith("/drives/D1/items/I1/content?@microsoft.graph.conflictBehavior=replace"));
  assert.deepEqual(calls[0].o?.extra, ["If-Match", "e1"]);
  await g.upload({ driveId: "D1", parentId: "P1", name: "Site plan #2.pdf", data: new Uint8Array(10) });
  assert.ok(calls[1].url.endsWith("/drives/D1/items/P1:/Site%20plan%20%232.pdf:/content?@microsoft.graph.conflictBehavior=fail"));
});

test("graph: large save uses an upload session in chunks without sending the token to it", async () => {
  const size = SIMPLE_UPLOAD_MAX + CHUNK + 100;
  const { f, calls } = fake((m, url) => {
    if (url.endsWith("/createUploadSession")) return { uploadUrl: "https://hive.sharepoint.com/upload/abc" };
    return { id: "I5", name: "big.pdf", parentReference: { driveId: "D1" } };
  });
  const g = new Graph(f, async () => "T");
  const it = await g.upload({ driveId: "D1", parentId: "P1", name: "big.pdf", data: new Uint8Array(size), replace: true });
  assert.equal(it.id, "I5");
  const puts = calls.filter((c) => c.url.startsWith("https://hive.sharepoint.com/upload"));
  assert.equal(puts.length, Math.ceil(size / CHUNK));
  assert.ok(puts.every((c) => !c.o?.token));
  assert.equal(puts[0].o?.extra?.[1], `bytes 0-${CHUNK - 1}/${size}`);
  assert.equal(puts.at(-1)!.o?.extra?.[1], `bytes ${(puts.length - 1) * CHUNK}-${size - 1}/${size}`);
});

test("graph: errors read as plain language", async () => {
  const { f } = fake(() => new Error('HTTP 412: {"error":{"code":"resourceModified","message":"ETag does not match"}}'));
  const g = new Graph(f, async () => "T");
  await assert.rejects(g.upload({ driveId: "D", itemId: "I", eTag: "old", data: new Uint8Array(1) }), (e: Error & { status?: number }) => e.status === 412 && /changed the file/.test(e.message));
});
