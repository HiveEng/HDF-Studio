// Microsoft 365 (Entra ID) sign-in for desktop apps: authorization code + PKCE with a loopback redirect.
// The system browser does the sign-in, so passwords, MFA and passkeys never pass through HDF Studio.
// The ID token (audience = our app) is what the review server checks; the refresh token keeps people
// signed in between sessions. Everything that touches the OS is injected so this also runs in tests.

export interface MsConfig { tenant: string; clientId: string; domains: string[] }
export interface MsUser { name: string; email: string }
export interface AuthIO {
  /** Start a one-shot web server on 127.0.0.1 and return its port. */
  listen(): Promise<number>;
  /** Wait for the browser redirect and return its query string ("code=…&state=…"). */
  wait(timeoutSecs: number): Promise<string>;
  openUrl(url: string): Promise<void>;
  /** POST application/x-www-form-urlencoded and return the response text. */
  postForm(url: string, body: string): Promise<string>;
  store: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

interface Saved { idToken: string; refreshToken: string; exp: number; name: string; email: string }

const SCOPES = "openid profile email offline_access";
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function decodeJwt(t: string): Record<string, unknown> {
  const p = t.split(".")[1] ?? "";
  const bin = atob(p.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((p.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
export const emailOf = (c: Record<string, unknown>) => String(c.email ?? c.preferred_username ?? c.upn ?? "").toLowerCase();

export class MsAuth {
  private key: string;
  private pending: Promise<string | null> | null = null;
  constructor(readonly cfg: MsConfig, private io: AuthIO) {
    this.key = `hdfstudio.ms.${cfg.tenant}.${cfg.clientId}`;
  }
  private get base() {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenant)}/oauth2/v2.0`;
  }
  private now() {
    return (this.io.now ?? Date.now)();
  }
  private rand(n: number) {
    return this.io.random ? this.io.random(n) : crypto.getRandomValues(new Uint8Array(n));
  }
  private load(): Saved | null {
    try {
      return JSON.parse(this.io.store.getItem(this.key) ?? "null");
    } catch {
      return null;
    }
  }
  currentUser(): MsUser | null {
    const s = this.load();
    return s ? { name: s.name, email: s.email } : null;
  }
  signOut() {
    this.io.store.removeItem(this.key);
  }

  /** Turn a token response into a saved session, checking the account is one we accept. */
  private accept(text: string, oldRefresh?: string): Saved {
    let j: Record<string, string>;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error("Microsoft sign-in sent an unexpected answer");
    }
    if (j.error) throw new Error(`Microsoft sign-in failed: ${j.error_description?.split("\r\n")[0] ?? j.error}`);
    if (!j.id_token) throw new Error("Microsoft sign-in did not return an ID token");
    const c = decodeJwt(j.id_token);
    const email = emailOf(c);
    const domains = this.cfg.domains.map((d) => d.toLowerCase().replace(/^@/, ""));
    if (domains.length && !domains.some((d) => email.endsWith("@" + d)))
      throw new Error(`Sign in with your ${domains.map((d) => "@" + d).join(" or ")} account (you signed in as ${email || "an unknown account"})`);
    const s: Saved = { idToken: j.id_token, refreshToken: j.refresh_token || oldRefresh || "", exp: Number(c.exp ?? 0) * 1000, name: String(c.name ?? email), email };
    this.io.store.setItem(this.key, JSON.stringify(s));
    return s;
  }

  /** Open the browser and sign in. Resolves with the ID token. */
  async signIn(): Promise<string> {
    const verifier = b64url(this.rand(32));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const state = b64url(this.rand(16));
    const port = await this.io.listen();
    const redirect = `http://localhost:${port}`;
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: redirect,
      response_mode: "query",
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      prompt: "select_account",
    });
    if (this.cfg.domains[0]) q.set("domain_hint", this.cfg.domains[0].replace(/^@/, ""));
    const back = this.io.wait(300);
    await this.io.openUrl(`${this.base}/authorize?${q}`);
    const r = new URLSearchParams(await back);
    if (r.get("error")) throw new Error(r.get("error") === "access_denied" ? "Sign-in was cancelled" : `Microsoft sign-in failed: ${r.get("error_description") ?? r.get("error")}`);
    if (r.get("state") !== state) throw new Error("Sign-in answer did not match the request; try again");
    const body = new URLSearchParams({ client_id: this.cfg.clientId, grant_type: "authorization_code", code: r.get("code") ?? "", redirect_uri: redirect, code_verifier: verifier, scope: SCOPES });
    return this.accept(await this.io.postForm(`${this.base}/token`, body.toString())).idToken;
  }

  /** A valid ID token: the saved one, a refreshed one, or (if interactive) a fresh sign-in. */
  getToken(interactive = true): Promise<string | null> {
    if (this.pending) return this.pending;
    const s = this.load();
    if (s && s.exp - 5 * 60_000 > this.now()) return Promise.resolve(s.idToken);
    const run = async (): Promise<string | null> => {
      if (s?.refreshToken) {
        try {
          const body = new URLSearchParams({ client_id: this.cfg.clientId, grant_type: "refresh_token", refresh_token: s.refreshToken, scope: SCOPES });
          return this.accept(await this.io.postForm(`${this.base}/token`, body.toString()), s.refreshToken).idToken;
        } catch {
          /* expired or revoked: sign in again */
        }
      }
      return interactive ? this.signIn() : null;
    };
    const p = run().finally(() => (this.pending = null));
    this.pending = p;
    return p;
  }
}
