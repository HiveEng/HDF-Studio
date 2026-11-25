// Shared review client: keeps one open document's comments in sync with a review server.
// Pulls other reviewers' changes, pushes ours, last write wins. Works in the app and in Node.
import type { CommentItem } from "../engine/annotations";

export interface ReviewEngine {
  commentItems(id: number): Promise<CommentItem[]> | CommentItem[];
  applyCommentChanges(id: number, upserts: string[], deletes: string[]): Promise<unknown> | unknown;
}

export interface ReviewLink { server: string; id: string }

/** Parse "http://host:8787/r/abc123", "http://host:8787#abc123" or the stored "server#id" form. */
export function parseReviewLink(s: string): ReviewLink | null {
  const t = s.trim();
  const m = /^(https?:\/\/[^\s#?]+?)\/(?:r|api\/reviews)\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/.exec(t) ?? /^(https?:\/\/[^\s#]+?)\/?#([A-Za-z0-9]+)$/.exec(t);
  return m ? { server: m[1].replace(/\/$/, ""), id: m[2] } : null;
}
export const formatReviewLink = (l: ReviewLink) => `${l.server}/r/${l.id}`;

export interface SyncResult { pulled: number; pushed: number; reviewers: string[] }

export class ReviewSync {
  private seq = 0;
  /** Last known XFDF per comment name (what the server and we agree on). */
  private known = new Map<string, string>();
  private knownAuthor = new Map<string, string>();
  private running: Promise<SyncResult> | null = null;
  private again = false;
  private events: { close(): void } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  reviewers: string[] = [];
  lastSync: Date | null = null;
  lastError: string | null = null;

  constructor(
    private engine: ReviewEngine,
    private docId: number,
    readonly link: ReviewLink,
    private o: {
      author: () => string;
      /** Bearer token: a shared access code or a Microsoft sign-in token. */
      token?: () => Promise<string | null> | string | null;
      fetch?: typeof fetch;
      onChange?: (r: SyncResult) => void;
      onError?: (msg: string) => void;
    },
  ) {}

  private async req(path: string, init: RequestInit = {}) {
    const token = await this.o.token?.();
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await (this.o.fetch ?? fetch)(`${this.link.server}/api/reviews/${this.link.id}${path}`, { ...init, headers });
    if (res.status === 401 || res.status === 403) throw new Error((await res.json().catch(() => null))?.error ?? "Not allowed on this review server");
    if (res.status === 404) throw new Error("This review no longer exists on the server");
    if (!res.ok) throw new Error(`Review server error ${res.status}`);
    return res.json();
  }

  /** Pull then push. Calls made while a sync runs are coalesced into one more run. */
  sync(): Promise<SyncResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = async (): Promise<SyncResult> => {
      let total: SyncResult = { pulled: 0, pushed: 0, reviewers: [] };
      do {
        this.again = false;
        const r = await this.once();
        total = { pulled: total.pulled + r.pulled, pushed: total.pushed + r.pushed, reviewers: r.reviewers };
      } while (this.again);
      return total;
    };
    this.running = run()
      .then((r) => {
        this.lastSync = new Date();
        this.lastError = null;
        if (r.pulled || r.pushed) this.o.onChange?.(r);
        return r;
      })
      .catch((e) => {
        this.lastError = (e as Error).message;
        this.o.onError?.(this.lastError);
        throw e;
      })
      .finally(() => (this.running = null));
    return this.running;
  }

  private async once(): Promise<SyncResult> {
    // 1. Pull
    const pull = (await this.req(`/comments?since=${this.seq}`)) as { seq: number; items: { name: string; author: string; xfdf: string; deleted: boolean }[] };
    const local = new Map((await this.engine.commentItems(this.docId)).map((c) => [c.name, c]));
    const upserts: string[] = [], deletes: string[] = [];
    for (const it of pull.items) {
      if (it.deleted) {
        if (local.has(it.name)) deletes.push(it.name);
        this.known.delete(it.name);
        continue;
      }
      this.knownAuthor.set(it.name, it.author);
      // Same as what we last agreed (e.g. our own change coming back): nothing new from others.
      // Any local edit or delete since then is pushed below.
      if (this.known.get(it.name) === it.xfdf) continue;
      upserts.push(it.xfdf);
    }
    if (upserts.length || deletes.length) await this.engine.applyCommentChanges(this.docId, upserts, deletes);
    const after = new Map((await this.engine.commentItems(this.docId)).map((c) => [c.name, c]));
    // Whatever we just received is the agreed state: remember our own rendering of it so it isn't echoed back.
    const applied = new Set(upserts.map((x) => /\bname="([^"]*)"/.exec(x)?.[1]));
    for (const it of pull.items) {
      if (it.deleted || this.known.get(it.name) === it.xfdf) continue;
      const mine = after.get(it.name);
      if (mine && applied.has(mine.xfdf.match(/\bname="([^"]*)"/)?.[1])) this.known.set(it.name, mine.xfdf);
    }
    this.seq = Math.max(this.seq, pull.seq);

    // 2. Push
    const me = this.o.author();
    const pushUp: { name: string; author: string; xfdf: string }[] = [];
    for (const c of after.values()) if (this.known.get(c.name) !== c.xfdf) pushUp.push({ name: c.name, author: c.author || me, xfdf: c.xfdf });
    // Only delete on the server what we removed and wrote ourselves (an undo of a sync mustn't wipe others' comments).
    const pushDel = [...this.known.keys()].filter((n) => !after.has(n) && (this.knownAuthor.get(n) ?? me) === me);
    if (pushUp.length || pushDel.length) {
      const r = (await this.req("/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upserts: pushUp, deletes: pushDel }) })) as { seq: number };
      for (const u of pushUp) {
        this.known.set(u.name, u.xfdf);
        this.knownAuthor.set(u.name, u.author);
      }
      for (const n of pushDel) this.known.delete(n);
      // Our own changes come back on the next pull; they match `known`, so they're skipped.
      void r;
    }
    const meta = (await this.req("")) as { reviewers: string[] };
    this.reviewers = meta.reviewers;
    return { pulled: upserts.length + deletes.length, pushed: pushUp.length + pushDel.length, reviewers: meta.reviewers };
  }

  /** Keep syncing: instantly on server events (browser/app) and every few seconds for local edits. */
  async start(intervalMs = 4000) {
    await this.sync();
    this.timer = setInterval(() => this.sync().catch(() => {}), intervalMs);
    if (typeof EventSource !== "undefined") {
      const token = await this.o.token?.();
      const es = new EventSource(`${this.link.server}/api/reviews/${this.link.id}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      es.onmessage = () => this.sync().catch(() => {});
      this.events = es;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.events?.close();
    this.events = null;
  }
}

/** Upload a PDF to start a review. */
export async function createReview(server: string, name: string, pdf: Uint8Array, token?: string | null, f: typeof fetch = fetch): Promise<ReviewLink> {
  const res = await f(`${server.replace(/\/$/, "")}/api/reviews?name=${encodeURIComponent(name)}`, { method: "POST", body: pdf as BodyInit, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Review server error ${res.status}`);
  const j = (await res.json()) as { id: string };
  return { server: server.replace(/\/$/, ""), id: j.id };
}

export async function downloadReview(link: ReviewLink, token?: string | null, f: typeof fetch = fetch): Promise<{ name: string; pdf: Uint8Array }> {
  const h: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const meta = await f(`${link.server}/api/reviews/${link.id}`, { headers: h });
  if (!meta.ok) throw new Error(meta.status === 404 ? "Review not found on that server" : meta.status === 401 ? "This review server needs you to sign in" : `Review server error ${meta.status}`);
  const { name } = (await meta.json()) as { name: string };
  const pdf = await f(`${link.server}/api/reviews/${link.id}/pdf`, { headers: h });
  return { name, pdf: new Uint8Array(await pdf.arrayBuffer()) };
}
