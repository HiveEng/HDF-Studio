import { test } from "node:test";
import assert from "node:assert/strict";
import { MsAuth, type AuthIO } from "../src/auth/msauth";

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

test("Microsoft sign-in: PKCE loopback flow, domain check, refresh", async () => {
  const store = memStore();
  let now = 1_000_000_000_000;
  let opened = "";
  const posts: URLSearchParams[] = [];
  let email = "pat@hiveng.ca";
  const io: AuthIO = {
    listen: async () => 51234,
    wait: async () => {
      while (!opened) await new Promise((r) => setTimeout(r, 1));
      const u = new URL(opened);
      return `code=abc&state=${u.searchParams.get("state")}`;
    },
    openUrl: async (u) => void (opened = u),
    postForm: async (_url, body) => {
      const p = new URLSearchParams(body);
      posts.push(p);
      return JSON.stringify({ id_token: jwt({ name: "Pat Lee", preferred_username: email, exp: now / 1000 + 3600 }), refresh_token: "r" + posts.length });
    },
    store,
    now: () => now,
  };
  const auth = new MsAuth({ tenant: "contoso-tenant", clientId: "cid", domains: ["hiveng.ca"] }, io);
  assert.equal(auth.currentUser(), null);
  const tok = await auth.getToken();
  assert.ok(tok);
  const u = new URL(opened);
  assert.equal(u.origin + u.pathname, "https://login.microsoftonline.com/contoso-tenant/oauth2/v2.0/authorize");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:51234");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("domain_hint"), "hiveng.ca");
  assert.equal(posts[0].get("grant_type"), "authorization_code");
  assert.equal(posts[0].get("code"), "abc");
  // The verifier hashes to the challenge.
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(posts[0].get("code_verifier")!).digest("base64url"), u.searchParams.get("code_challenge"));
  assert.deepEqual(auth.currentUser(), { name: "Pat Lee", email: "pat@hiveng.ca" });

  // Still valid: no network.
  assert.equal(await auth.getToken(), tok);
  assert.equal(posts.length, 1);
  // Expired: silent refresh with the refresh token.
  now += 3600_000;
  opened = "";
  await auth.getToken(false);
  assert.equal(posts[1].get("grant_type"), "refresh_token");
  assert.equal(posts[1].get("refresh_token"), "r1");
  assert.equal(opened, "");

  // Wrong domain is refused and nothing is saved.
  auth.signOut();
  email = "someone@gmail.com";
  await assert.rejects(auth.signIn(), /@hiveng\.ca/);
  assert.equal(auth.currentUser(), null);
  // Not signed in and not interactive: no token, no browser.
  opened = "";
  assert.equal(await auth.getToken(false), null);
  assert.equal(opened, "");
});

test("Microsoft sign-in: cancelled and mismatched answers", async () => {
  const mk = (answer: (state: string) => string) => {
    let opened = "";
    return new MsAuth({ tenant: "t", clientId: "c", domains: [] }, {
      listen: async () => 1,
      wait: async () => {
        while (!opened) await new Promise((r) => setTimeout(r, 1));
        return answer(new URL(opened).searchParams.get("state")!);
      },
      openUrl: async (u) => void (opened = u),
      postForm: async () => JSON.stringify({ error: "invalid_grant", error_description: "AADSTS70008: expired\r\nTrace" }),
      store: memStore(),
    });
  };
  await assert.rejects(mk(() => "error=access_denied").signIn(), /cancelled/);
  await assert.rejects(mk(() => "code=x&state=wrong").signIn(), /did not match/);
  await assert.rejects(mk((s) => `code=x&state=${s}`).signIn(), /AADSTS70008: expired$/);
});

test("Microsoft sign-in: staff-only check (tenant, offline, revoked)", async () => {
  const TENANT = "2cc319ea-c91f-4964-92a2-807a20ffe7b6";
  const store = memStore();
  let mode: "ok" | "offline" | "revoked" | "other-tenant" | "busy" | "mfa" = "ok";
  let guest = false;
  let opened = "";
  const auth = new MsAuth({ tenant: TENANT, clientId: "cid", domains: [] }, {
    listen: async () => 1,
    wait: async () => {
      while (!opened) await new Promise((r) => setTimeout(r, 1));
      return `code=x&state=${new URL(opened).searchParams.get("state")}`;
    },
    openUrl: async (u) => void (opened = u),
    postForm: async () => {
      if (mode === "offline") throw new Error("Could not reach Microsoft sign-in");
      if (mode === "busy") return JSON.stringify({ error: "temporarily_unavailable", error_description: "AADSTS90033: service busy" });
      if (mode === "mfa") return JSON.stringify({ error: "interaction_required", error_description: "AADSTS50076: MFA needed" });
      if (mode === "revoked") return JSON.stringify({ error: "invalid_grant", error_description: "AADSTS50057: account disabled" });
      return JSON.stringify({ id_token: jwt({ name: "Pat", email: guest ? "Guest.Person@gmail.com" : "pat@hiveeng.ca", tid: mode === "other-tenant" ? "00000000-0000-0000-0000-000000000000" : TENANT, exp: Date.now() / 1000 + 3600 }), refresh_token: "r" });
    },
    store,
  });
  assert.equal((await auth.check()).status, "signin");
  mode = "other-tenant";
  await assert.rejects(auth.signIn(), /work account/);
  assert.equal(auth.currentUser(), null);
  mode = "ok";
  opened = "";
  await auth.signIn();
  assert.equal(auth.currentUser()?.email, "pat@hiveeng.ca");
  // An invited Gmail guest signs in through our tenant, so it is accepted like staff.
  guest = true;
  opened = "";
  await auth.signIn();
  assert.equal(auth.currentUser()?.email, "guest.person@gmail.com");
  guest = false;
  opened = "";
  await auth.signIn();
  const ok = await auth.check();
  assert.equal(ok.status, "ok");
  mode = "offline";
  const off = await auth.check();
  assert.equal(off.status, "offline");
  assert.ok(off.checked! > Date.now() - 60_000);
  // A busy service or a fresh MFA prompt doesn't throw staff out: they stay signed in on this computer.
  mode = "busy";
  assert.equal((await auth.check()).status, "offline");
  mode = "mfa";
  assert.equal((await auth.check()).status, "offline");
  assert.equal(auth.currentUser()?.email, "pat@hiveeng.ca");
  mode = "revoked";
  assert.equal((await auth.check()).status, "signin");
  assert.equal(auth.currentUser(), null);
});
