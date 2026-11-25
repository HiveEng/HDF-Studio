// Shared review in the app: start a review from the open PDF, join one from a link, and keep
// everyone's comments in sync live. Signs in with Microsoft 365 when the server asks for it.
import { ReviewSync, createReview, downloadReview, formatReviewLink, parseReviewLink, type ReviewLink, type SyncResult } from "../review/client";
import { MsAuth, type MsConfig } from "../review/msauth";
import { httpPostForm, oauthListen, oauthWait, openUrl } from "../platform";
import type { CommentItem } from "../engine/annotations";
import type { DocInfo } from "../engine/core";
import { ask, confirmDialog } from "./dialog";

export interface ReviewDeps {
  engine: {
    commentItems(id: number): Promise<CommentItem[]>;
    applyCommentChanges(id: number, upserts: string[], deletes: string[]): Promise<unknown>;
    reviewLink(id: number): Promise<string | null>;
    setReviewLink(id: number, link: string | null): Promise<void>;
    save(id: number, options?: string): Promise<Uint8Array>;
  };
  doc(): { info: DocInfo; name: string } | null;
  /** Open a downloaded review copy in a new tab; returns its document id. */
  openCopy(name: string, pdf: Uint8Array): Promise<number | null>;
  /** Comments changed in document `id` (from other reviewers). */
  changed(id: number, r: SyncResult): void;
  /** The connection state changed (redraw the Comments panel). */
  stateChanged(): void;
  status(msg: string): void;
  fetch?: typeof fetch;
}

type ServerConfig = { auth: "none" } | { auth: "token" } | ({ auth: "microsoft" } & MsConfig);
interface Session { sync: ReviewSync; auth: ServerConfig; error: string | null; user: string | null }

const SERVER_KEY = "hdfstudio.reviewServer";
const CODES_KEY = "hdfstudio.reviewCodes";
const codes = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(CODES_KEY) ?? "{}");
  } catch {
    return {};
  }
};
const author = () => localStorage.getItem("hdfstudio.author") || "Reviewer";

export function setupReview(d: ReviewDeps) {
  const f: typeof fetch = (...a) => (d.fetch ?? fetch)(...a);
  const sessions = new Map<number, Session>();
  /** Review links found in opened files that aren't connected yet (needs a click, so we never pop a browser on open). */
  const offered = new Map<number, ReviewLink>();
  const msAuths = new Map<string, MsAuth>();

  async function serverConfig(server: string): Promise<ServerConfig> {
    let res: Response;
    try {
      res = await f(`${server}/api/config`);
    } catch {
      throw new Error(`Could not reach the review server at ${server}`);
    }
    if (!res.ok) throw new Error(`${server} doesn't look like an HDF Studio review server`);
    return res.json();
  }
  function msAuth(c: MsConfig) {
    const k = `${c.tenant}|${c.clientId}`;
    if (!msAuths.has(k))
      msAuths.set(k, new MsAuth(c, { listen: oauthListen, wait: oauthWait, openUrl, postForm: httpPostForm, store: localStorage }));
    return msAuths.get(k)!;
  }
  /** A token getter for this server. Interactive = may open the browser or ask for the access code. */
  async function tokenFor(server: string, c: ServerConfig, interactive: boolean): Promise<(() => Promise<string | null>) | null> {
    if (c.auth === "none") return async () => null;
    if (c.auth === "microsoft") {
      const a = msAuth(c);
      const t = await a.getToken(interactive);
      if (!t) return null;
      const u = a.currentUser();
      if (u) localStorage.setItem("hdfstudio.author", u.name);
      return () => a.getToken(false);
    }
    let code = codes()[server];
    if (!code) {
      if (!interactive) return null;
      code = (await ask("Review server access code", [{ name: "c", label: "Access code", type: "password", hint: "Ask whoever runs the review server for the code." }], "Connect"))?.c ?? "";
      if (!code) return null;
      localStorage.setItem(CODES_KEY, JSON.stringify({ ...codes(), [server]: code }));
    }
    return async () => code!;
  }
  const forgetCode = (server: string) => {
    const c = codes();
    delete c[server];
    localStorage.setItem(CODES_KEY, JSON.stringify(c));
  };

  async function connect(id: number, link: ReviewLink, interactive: boolean, config?: ServerConfig): Promise<boolean> {
    const c = config ?? (await serverConfig(link.server));
    const token = await tokenFor(link.server, c, interactive);
    if (!token) return false;
    sessions.get(id)?.sync.stop();
    const s: Session = { auth: c, error: null, user: c.auth === "microsoft" ? msAuth(c).currentUser()?.email ?? null : null, sync: null! };
    s.sync = new ReviewSync(d.engine, id, link, {
      author,
      token,
      fetch: f,
      onChange: (r) => {
        if (r.pulled) d.changed(id, r);
        d.stateChanged();
      },
      onError: (m) => {
        if (s.error !== m) {
          s.error = m;
          d.stateChanged();
        }
      },
    });
    sessions.set(id, s);
    offered.delete(id);
    try {
      await s.sync.start();
    } catch (e) {
      const msg = (e as Error).message;
      if (c.auth === "token" && /access token/i.test(msg)) forgetCode(link.server);
      s.sync.stop();
      sessions.delete(id);
      throw e;
    }
    const tick = s.sync.sync.bind(s.sync);
    // Clear a past error as soon as a sync works again.
    s.sync.sync = () =>
      tick().then((r) => {
        if (s.error) {
          s.error = null;
          d.stateChanged();
        }
        return r;
      });
    d.stateChanged();
    return true;
  }

  async function askServer(): Promise<string | null> {
    const r = await ask(
      "Review server",
      [{ name: "s", label: "Server address", value: localStorage.getItem(SERVER_KEY) ?? "", placeholder: "https://review.example.com", hint: "Your team's HDF Studio review server (hdfstudio review-server)." }],
      "Next",
    );
    const s = r?.s.trim().replace(/\/+$/, "");
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) {
      d.status("The server address must start with http:// or https://");
      return null;
    }
    localStorage.setItem(SERVER_KEY, s);
    return s;
  }

  async function copyLink(link: ReviewLink) {
    await navigator.clipboard.writeText(formatReviewLink(link)).catch(() => {});
    d.status(`Review link copied: ${formatReviewLink(link)}. Send it to your reviewers.`);
  }

  /** Upload the open PDF and start a live review of it. */
  async function startReview() {
    const doc = d.doc();
    if (!doc) return d.status("Open a PDF to review first");
    const id = doc.info.id;
    const cur = sessions.get(id);
    if (cur) return copyLink(cur.sync.link);
    const server = await askServer();
    if (!server) return;
    try {
      d.status("Connecting to the review server…");
      const c = await serverConfig(server);
      if (c.auth === "microsoft") d.status("Sign in with your Microsoft account in the browser window that opened…");
      const token = await tokenFor(server, c, true);
      if (!token) return d.status("Shared review cancelled");
      d.status(`Uploading ${doc.name}…`);
      await d.engine.commentItems(id); // gives every comment a stable name before the upload
      const link = await createReview(server, doc.name, await d.engine.save(id), await token(), f);
      await d.engine.setReviewLink(id, `${link.server}#${link.id}`);
      await connect(id, link, false, c);
      await copyLink(link);
    } catch (e) {
      d.status(`Could not start the review: ${(e as Error).message}`);
      d.stateChanged();
    }
  }

  /** Open a review someone shared, by its link. */
  async function joinReview(text?: string) {
    const r = text ? { l: text } : await ask("Join a shared review", [{ name: "l", label: "Review link", placeholder: "https://review.example.com/r/…", hint: "Paste the link the review's owner sent you." }], "Join");
    if (!r?.l) return;
    const link = parseReviewLink(r.l);
    if (!link) return d.status("That doesn't look like a review link (it should end in /r/ and a code)");
    for (const [id, s] of sessions) if (s.sync.link.id === link.id && s.sync.link.server === link.server) return d.status(`You're already in this review (document ${id})`);
    try {
      d.status("Connecting to the review server…");
      const c = await serverConfig(link.server);
      if (c.auth === "microsoft") d.status("Sign in with your Microsoft account in the browser window that opened…");
      const token = await tokenFor(link.server, c, true);
      if (!token) return d.status("Join cancelled");
      const { name, pdf } = await downloadReview(link, await token(), f);
      const id = await d.openCopy(name, pdf);
      if (id == null) return;
      await d.engine.setReviewLink(id, `${link.server}#${link.id}`);
      await connect(id, link, false, c);
      d.status(`Joined the review of ${name}. Comments sync live.`);
    } catch (e) {
      d.status(`Could not join the review: ${(e as Error).message}`);
    }
  }

  async function leaveReview(id = d.doc()?.info.id) {
    if (id == null) return;
    const s = sessions.get(id);
    if (!s && !offered.has(id)) return d.status("This document isn't in a shared review");
    if (!(await confirmDialog("Stop syncing comments for this document? Your comments stay in the file.", "Leave review"))) return;
    s?.sync.stop();
    sessions.delete(id);
    offered.delete(id);
    await d.engine.setReviewLink(id, null);
    d.stateChanged();
    d.status("Left the shared review");
  }

  /** Called after a file opens: reconnect if it belongs to a review and we can do so silently. */
  async function opened(id: number) {
    const raw = await d.engine.reviewLink(id).catch(() => null);
    const link = raw && parseReviewLink(raw);
    if (!link) return;
    offered.set(id, link);
    d.stateChanged();
    try {
      await connect(id, link, false);
    } catch (e) {
      const s = sessions.get(id);
      if (s) s.error = (e as Error).message;
      d.status(`Shared review: ${(e as Error).message}`);
    }
  }
  function closed(id: number) {
    sessions.get(id)?.sync.stop();
    sessions.delete(id);
    offered.delete(id);
  }

  const ago = (t: Date | null) => {
    if (!t) return "not yet";
    const s = Math.round((Date.now() - t.getTime()) / 1000);
    return s < 10 ? "just now" : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  };

  /** Status bar shown at the top of the Comments panel for a document in a review. */
  function bar(id: number): HTMLElement | null {
    const s = sessions.get(id);
    const link = s?.sync.link ?? offered.get(id);
    if (!link) return null;
    const el = document.createElement("div");
    el.className = "review-bar" + (s ? (s.error ? " error" : " live") : "");
    const line = document.createElement("div");
    line.className = "rb-status";
    const host = link.server.replace(/^https?:\/\//, "");
    line.textContent = !s
      ? `Shared review on ${host}: not connected`
      : s.error
        ? `Shared review: ${s.error}`
        : `Live review on ${host} · synced ${ago(s.sync.lastSync)}`;
    el.append(line);
    if (s?.sync.reviewers.length) {
      const who = document.createElement("div");
      who.className = "rb-who";
      who.textContent = `Reviewers: ${s.sync.reviewers.join(", ")}`;
      el.append(who);
    }
    if (s?.user) {
      const me = document.createElement("div");
      me.className = "rb-who";
      me.textContent = `Signed in as ${s.user}`;
      el.append(me);
    }
    const btns = document.createElement("div");
    btns.className = "rb-actions";
    const btn = (label: string, title: string, run: () => void, primary = false) => {
      const b = Object.assign(document.createElement("button"), { textContent: label, title, onclick: run });
      if (primary) b.className = "primary";
      btns.append(b);
    };
    if (!s || s.error)
      btn(s ? "Reconnect" : "Connect", "Connect to the review server and sync comments", async () => {
        try {
          await connect(id, link, true);
          d.status("Connected to the shared review");
        } catch (e) {
          d.status(`Shared review: ${(e as Error).message}`);
          d.stateChanged();
        }
      }, true);
    else btn("Sync now", "Fetch and send comments now", () => s.sync.sync().catch(() => {}));
    btn("Copy link", "Copy the review link to send to reviewers", () => copyLink(link));
    btn("Leave", "Stop syncing this document's comments", () => leaveReview(id));
    el.append(btns);
    return el;
  }

  /** Sign out of Microsoft for every review server. */
  function signOut() {
    for (const a of msAuths.values()) a.signOut();
    for (const k of Object.keys(localStorage)) if (k.startsWith("hdfstudio.ms.")) localStorage.removeItem(k);
    d.status("Signed out of Microsoft. You'll be asked to sign in next time a review needs it.");
  }

  /** Push local edits right away instead of waiting for the next poll. */
  const nudgeTimers = new Map<number, number>();
  function nudge(id: number) {
    const s = sessions.get(id);
    if (!s) return;
    clearTimeout(nudgeTimers.get(id));
    nudgeTimers.set(id, window.setTimeout(() => s.sync.sync().catch(() => {}), 250));
  }

  return { startReview, nudge, joinReview, leaveReview, opened, closed, bar, signOut, inReview: (id: number) => sessions.has(id) };
}
