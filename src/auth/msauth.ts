// Microsoft 365 (Entra ID) sign-in for desktop apps: authorization code + PKCE with a loopback redirect.
// The system browser does the sign-in, so passwords, MFA and passkeys never pass through HDS.
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

interface Saved { idToken: string; refreshToken: string; exp: number; name: string; email: string; /** Last time Microsoft confirmed the account. */ checked?: number }

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

  /** Access tokens for other APIs (Microsoft Graph), by scope list. Memory only. */
  private access = new Map<string, { token: string; exp: number }>();
  private lastJson: Record<string, string> = {};

  /** Turn a token response into a saved session, checking the account is one we accept. */
  private accept(text: string, oldRefresh?: string): Saved {
    let j: Record<string, string>;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error("Microsoft sign-in sent an unexpected answer");
    }
    this.lastJson = j;
    if (j.error) throw Object.assign(new Error(`Microsoft sign-in failed: ${j.error_description?.split("\r\n")[0] ?? j.error}`), { code: j.error, description: j.error_description ?? "" });
    if (!j.id_token) throw new Error("Microsoft sign-in did not return an ID token");
    const c = decodeJwt(j.id_token);
    const email = emailOf(c);
    // Only accounts from our own Microsoft 365 organization (the tenant), whatever their email domain.
    // Invited guests (for example a Gmail address) sign in through the tenant, so they pass this check.
    if (/^[0-9a-f-]{36}$/i.test(this.cfg.tenant) && c.tid && String(c.tid).toLowerCase() !== this.cfg.tenant.toLowerCase())
      throw new Error(`Sign in with your Hive work account, or a Gmail address Hive has invited (you signed in as ${email || "an account from another organization"})`);
    const domains = this.cfg.domains.map((d) => d.toLowerCase().replace(/^@/, ""));
    if (domains.length && !domains.some((d) => email.endsWith("@" + d)))
      throw new Error(`Sign in with your ${domains.map((d) => "@" + d).join(" or ")} account (you signed in as ${email || "an unknown account"})`);
    const s: Saved = { idToken: j.id_token, refreshToken: j.refresh_token || oldRefresh || "", exp: Number(c.exp ?? 0) * 1000, name: String(c.name ?? email), email, checked: this.now() };
    this.io.store.setItem(this.key, JSON.stringify(s));
    return s;
  }

  /** Open the browser and sign in. Resolves with the ID token. */
  async signIn(extraScopes = ""): Promise<string> {
    const scope = [SCOPES, extraScopes].filter(Boolean).join(" ");
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
      scope,
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
    const body = new URLSearchParams({ client_id: this.cfg.clientId, grant_type: "authorization_code", code: r.get("code") ?? "", redirect_uri: redirect, code_verifier: verifier, scope });
    const saved = this.accept(await this.io.postForm(`${this.base}/token`, body.toString()));
    if (extraScopes) this.keepAccess(extraScopes);
    return saved.idToken;
  }

  /**
   * Check the saved session with Microsoft without any window: "ok" when the account is still
   * active, "offline" when Microsoft can't be reached (the saved session stands), "signin" when
   * there's no session or Microsoft refused it (account disabled, password reset, signed out).
   */
  async check(): Promise<{ status: "ok" | "offline" | "signin"; user?: MsUser; checked?: number }> {
    const s = this.load();
    if (!s?.refreshToken) return { status: "signin" };
    let text: string;
    try {
      const body = new URLSearchParams({ client_id: this.cfg.clientId, grant_type: "refresh_token", refresh_token: s.refreshToken, scope: SCOPES });
      text = await this.io.postForm(`${this.base}/token`, body.toString());
    } catch {
      return { status: "offline", user: { name: s.name, email: s.email }, checked: s.checked ?? 0 };
    }
    try {
      const n = this.accept(text, s.refreshToken);
      return { status: "ok", user: { name: n.name, email: n.email }, checked: n.checked };
    } catch (e) {
      // Only a definite "no" ends the session: account disabled or deleted, password reset, sign-in revoked,
      // or an account from another organization. Anything else (Microsoft busy, a policy asking for MFA again,
      // an odd answer) keeps the saved sign-in, so staff sign in once per computer, not every launch.
      const code = (e as { code?: string }).code ?? "";
      const definite = code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client" || /work account|Sign in with your/.test(String((e as Error).message));
      if (!definite) return { status: "offline", user: { name: s.name, email: s.email }, checked: s.checked ?? 0 };
      this.signOut();
      return { status: "signin" };
    }
  }

  private keepAccess(scopes: string) {
    const j = this.lastJson;
    if (j.access_token) this.access.set(scopes, { token: j.access_token, exp: this.now() + Number(j.expires_in ?? 3600) * 1000 });
  }

  /**
   * An access token for another API, e.g. Microsoft Graph ("https://graph.microsoft.com/Files.ReadWrite.All …").
   * Uses the saved sign-in silently; when consent or a fresh sign-in is needed and `interactive` is set,
   * opens the browser once (the user, or an admin for the whole organization, approves the access).
   */
  async accessToken(scopes: string, interactive = true): Promise<string> {
    const c = this.access.get(scopes);
    if (c && c.exp - 5 * 60_000 > this.now()) return c.token;
    const s = this.load();
    if (s?.refreshToken) {
      try {
        const body = new URLSearchParams({ client_id: this.cfg.clientId, grant_type: "refresh_token", refresh_token: s.refreshToken, scope: `${SCOPES} ${scopes}` });
        this.accept(await this.io.postForm(`${this.base}/token`, body.toString()), s.refreshToken);
        this.keepAccess(scopes);
        const t = this.access.get(scopes);
        if (t) return t.token;
      } catch (e) {
        const code = (e as { code?: string }).code;
        const desc = (e as { description?: string }).description ?? "";
        // Admin approval is needed and the user can't give it: say so plainly.
        if (/AADSTS65001|AADSTS90094|AADSTS90008/.test(desc) && !interactive) throw new Error("HDS needs permission to reach OneDrive and SharePoint. Ask your Microsoft 365 admin to approve it.");
        if (code && !/interaction_required|consent_required|invalid_grant|login_required/.test(code) && !/AADSTS65001/.test(desc)) throw e;
        /* consent or sign-in needed: fall through to the browser */
      }
    }
    if (!interactive) throw new Error("Sign in to Microsoft 365 first");
    await this.signIn(scopes);
    const t = this.access.get(scopes);
    if (!t) throw new Error("Microsoft did not grant access to OneDrive and SharePoint");
    return t.token;
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
