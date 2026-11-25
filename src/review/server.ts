// Shared review server: a small, dependency-free HTTP service that holds a PDF and its comments so
// several people can comment on the same document at once. Self-hosted (run it on any machine the
// reviewers can reach): `hdfstudio review-server --port 8787 --data ./reviews [--token secret]`.
//
// API (JSON unless noted; token via "Authorization: Bearer <token>" or ?token=):
//   POST /api/reviews?name=<file name>       body: PDF bytes        -> { id, name, created }
//   GET  /api/reviews                                               -> [{ id, name, created, comments, reviewers }]
//   GET  /api/reviews/:id                                           -> { id, name, created, seq, reviewers }
//   GET  /api/reviews/:id/pdf                                       -> the PDF
//   GET  /api/reviews/:id/comments?since=<seq>                      -> { seq, items: [{ name, author, xfdf, deleted, seq }] }
//   POST /api/reviews/:id/comments  { upserts: [{ name, author, xfdf }], deletes: [name] } -> { seq }
//   GET  /api/reviews/:id/events                                    -> server-sent events: { seq } on every change
//   GET  /r/:id                                                     -> a small page explaining how to join
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createVerifier, type MicrosoftAuth, type User } from "./auth";

export interface ReviewServerOptions {
  port?: number;
  host?: string;
  dataDir: string;
  /** Shared access code (simple setups). */
  token?: string;
  /** Microsoft 365 sign-in restricted to company domains (recommended). */
  microsoft?: MicrosoftAuth;
  log?: (msg: string) => void;
}

interface Item { name: string; author: string; xfdf: string; deleted: boolean; seq: number; updated: string; /** Verified email of whoever created it (sign-in mode). */ owner?: string }
interface Review { owner?: string; id: string; name: string; created: string; seq: number; items: Record<string, Item> }

const MAX_PDF = 300 * 1024 * 1024;
const MAX_JSON = 20 * 1024 * 1024;

export function startReviewServer(o: ReviewServerOptions): Promise<Server & { url: string }> {
  const log = o.log ?? (() => {});
  mkdirSync(o.dataDir, { recursive: true });
  const reviews = new Map<string, Review>();
  for (const id of readdirSync(o.dataDir)) {
    const f = join(o.dataDir, id, "review.json");
    if (existsSync(f)) {
      try {
        reviews.set(id, JSON.parse(readFileSync(f, "utf8")));
      } catch {
        log(`skipping unreadable review ${id}`);
      }
    }
  }
  const listeners = new Map<string, Set<ServerResponse>>();
  const persist = (r: Review) => {
    const dir = join(o.dataDir, r.id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, "review.json.tmp");
    writeFileSync(tmp, JSON.stringify(r));
    renameSync(tmp, join(dir, "review.json"));
  };
  const notify = (r: Review) => {
    for (const res of listeners.get(r.id) ?? []) res.write(`data: ${JSON.stringify({ seq: r.seq })}\n\n`);
  };
  const reviewers = (r: Review) => [...new Set(Object.values(r.items).filter((i) => !i.deleted && i.author).map((i) => i.author))].sort();

  const verifyMs = o.microsoft ? createVerifier(o.microsoft) : null;
  /** The caller, or an error message. Without sign-in configured everyone is "anonymous". */
  const authenticate = async (req: IncomingMessage, url: URL): Promise<User | null | string> => {
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
    if (verifyMs) {
      try {
        return await verifyMs(given);
      } catch (e) {
        return (e as Error).message;
      }
    }
    if (!o.token) return null;
    const a = Buffer.from(given), b = Buffer.from(o.token);
    return a.length === b.length && timingSafeEqual(a, b) ? null : "This review server needs an access token";
  };
  const send = (res: ServerResponse, status: number, body: unknown, type = "application/json") => {
    const data = type === "application/json" ? JSON.stringify(body) : (body as string | Buffer);
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  };
  const readBody = (req: IncomingMessage, limit: number) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error("Too large"), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === "r" && parts[1] && req.method === "GET") {
        const r = reviews.get(parts[1]);
        if (!r) return send(res, 404, "Review not found", "text/plain");
        const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
        return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Review: ${esc(r.name)}</title><body style="font:15px system-ui;max-width:560px;margin:60px auto;line-height:1.5"><h2>Shared review: ${esc(r.name)}</h2><p>To comment, open <b>HDF Studio</b>, choose <b>Comment › Shared review › Join</b> and paste this page's address.</p><p>${reviewers(r).length} reviewer(s) so far: ${esc(reviewers(r).join(", ") || "none yet")}.</p></body>`, "text/html; charset=utf-8");
      }
      // How to sign in (public, so the app can set itself up from just the server address).
      if (parts[0] === "api" && parts[1] === "config" && req.method === "GET")
        return send(res, 200, o.microsoft ? { auth: "microsoft", tenant: o.microsoft.tenant, clientId: o.microsoft.clientId, domains: o.microsoft.domains } : { auth: o.token ? "token" : "none" });
      if (parts[0] !== "api" || parts[1] !== "reviews") return send(res, 404, { error: "Not found" });
      const user = await authenticate(req, url);
      if (typeof user === "string") return send(res, 401, { error: user });
      const id = parts[2];
      if (!id) {
        if (req.method === "GET") return send(res, 200, [...reviews.values()].map((r) => ({ id: r.id, name: r.name, created: r.created, comments: Object.values(r.items).filter((i) => !i.deleted).length, reviewers: reviewers(r) })));
        if (req.method === "POST") {
          const pdf = await readBody(req, MAX_PDF);
          if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") return send(res, 400, { error: "That isn't a PDF" });
          const rid = randomBytes(6).toString("base64url").replace(/[-_]/g, "x");
          const r: Review = { owner: user?.email, id: rid, name: (url.searchParams.get("name") || "document.pdf").slice(0, 200), created: new Date().toISOString(), seq: 0, items: {} };
          mkdirSync(join(o.dataDir, rid), { recursive: true });
          writeFileSync(join(o.dataDir, rid, "document.pdf"), pdf);
          reviews.set(rid, r);
          persist(r);
          log(`new review ${rid}: ${r.name}`);
          return send(res, 201, { id: rid, name: r.name, created: r.created });
        }
        return send(res, 405, { error: "Method not allowed" });
      }
      const r = reviews.get(id);
      if (!r) return send(res, 404, { error: "Review not found" });
      const sub = parts[3];
      if (!sub && req.method === "GET") return send(res, 200, { id: r.id, name: r.name, created: r.created, seq: r.seq, reviewers: reviewers(r) });
      if (sub === "pdf" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${encodeURIComponent(r.name)}"` });
        return res.end(readFileSync(join(o.dataDir, r.id, "document.pdf")));
      }
      if (sub === "comments" && req.method === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        return send(res, 200, { seq: r.seq, items: Object.values(r.items).filter((i) => i.seq > since) });
      }
      if (sub === "comments" && req.method === "POST") {
        let body: { upserts?: { name: string; author?: string; xfdf: string }[]; deletes?: string[] };
        try {
          body = JSON.parse((await readBody(req, MAX_JSON)).toString("utf8"));
        } catch {
          return send(res, 400, { error: "Bad JSON" });
        }
        const now = new Date().toISOString();
        let changed = false;
        for (const u of body.upserts ?? []) {
          if (typeof u?.name !== "string" || typeof u.xfdf !== "string" || !u.name || u.xfdf.length > 2_000_000) continue;
          const prev = r.items[u.name];
          if (prev && !prev.deleted && prev.xfdf === u.xfdf) continue;
          // With sign-in, people can't change someone else's comment (they reply instead).
          if (user && prev?.owner && prev.owner !== user.email) continue;
          r.items[u.name] = { name: u.name, author: user ? user.name : String(u.author ?? prev?.author ?? "").slice(0, 120), xfdf: u.xfdf, deleted: false, seq: ++r.seq, updated: now, owner: user?.email ?? prev?.owner };
          changed = true;
        }
        for (const n of body.deletes ?? []) {
          const prev = r.items[n];
          if (!prev || prev.deleted) continue;
          if (user && prev.owner && prev.owner !== user.email) continue;
          r.items[n] = { ...prev, xfdf: "", deleted: true, seq: ++r.seq, updated: now };
          changed = true;
        }
        if (changed) {
          persist(r);
          notify(r);
        }
        return send(res, 200, { seq: r.seq });
      }
      if (sub === "events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`retry: 3000\ndata: ${JSON.stringify({ seq: r.seq })}\n\n`);
        let set = listeners.get(r.id);
        if (!set) listeners.set(r.id, (set = new Set()));
        set.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => {
          clearInterval(ping);
          set!.delete(res);
        });
        return;
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (!res.headersSent) send(res, status, { error: (e as Error).message });
    }
  });
  return new Promise((resolve) => {
    server.listen(o.port ?? 8787, o.host ?? "0.0.0.0", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : o.port;
      resolve(Object.assign(server, { url: `http://localhost:${port}` }));
    });
  });
}
