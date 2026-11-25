// Staff-only access: HDF Studio asks for a Hive Engineering Microsoft 365 sign-in before it can be
// used. The browser does the sign-in (MFA and Conditional Access apply); only accounts in Hive's
// own Microsoft 365 organization are accepted. After that the app works offline for a while, and
// a disabled or removed account is locked out the next time the app can reach Microsoft.
import { MsAuth, type MsUser } from "../auth/msauth";
import { oauthListen, oauthWait, httpPostForm, openExternal, isTauri } from "../platform";

/** Hive Engineering's app registration (these identify the app; they are not secrets). */
export const HIVE_AUTH = { tenant: "2cc319ea-c91f-4964-92a2-807a20ffe7b6", clientId: "8b0d9e7f-df7a-44e9-b939-4961db6bf450", domains: [] as string[] };
/** How long the app keeps working without reaching Microsoft. */
const OFFLINE_DAYS = 14;
const RECHECK_MS = 6 * 60 * 60 * 1000;

export function setupSignIn(o: { logoHtml: string; onUser(u: MsUser): void; status(msg: string): void }) {
  const auth = new MsAuth(HIVE_AUTH, { listen: oauthListen, wait: oauthWait, openUrl: openExternal, postForm: httpPostForm, store: localStorage });
  let user: MsUser | null = null;

  const gate = document.createElement("div");
  gate.id = "signinGate";
  gate.className = "signin-gate hidden";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-modal", "true");
  gate.innerHTML = `
    <div class="signin-card">
      <div class="signin-logo">${o.logoHtml}</div>
      <h1>HDF Studio</h1>
      <p class="signin-why">For Hive Engineering staff. Sign in with your work Microsoft 365 account to continue.</p>
      <button type="button" class="primary signin-btn">Sign in with Microsoft</button>
      <p class="signin-msg" aria-live="polite"></p>
      <p class="signin-note">Your browser opens for the sign-in, so your password never passes through HDF Studio.</p>
    </div>`;
  document.body.append(gate);
  const btn = gate.querySelector<HTMLButtonElement>(".signin-btn")!;
  const msg = gate.querySelector<HTMLElement>(".signin-msg")!;
  // While locked, nothing behind the gate reacts to keys.
  window.addEventListener("keydown", (e) => {
    if (!gate.classList.contains("hidden") && !gate.contains(e.target as Node)) (e.stopImmediatePropagation(), e.preventDefault());
  }, true);

  function lock(text = "") {
    msg.textContent = text;
    gate.classList.remove("hidden");
    btn.disabled = false;
    btn.focus();
  }
  function unlock(u: MsUser) {
    user = u;
    gate.classList.add("hidden");
    o.onUser(u);
  }

  btn.onclick = async () => {
    btn.disabled = true;
    msg.textContent = "Finish signing in in your browser…";
    try {
      await auth.signIn();
      const u = auth.currentUser()!;
      unlock(u);
      o.status(`Signed in as ${u.name} (${u.email})`);
    } catch (e) {
      lock(String((e as Error).message ?? e));
    }
  };

  async function verify(startup: boolean) {
    const r = await auth.check();
    if (r.status === "ok") return unlock(r.user!);
    if (r.status === "offline") {
      const days = (Date.now() - (r.checked ?? 0)) / 86_400_000;
      if (days <= OFFLINE_DAYS) return startup ? unlock(r.user!) : undefined;
      return lock(`HDF Studio couldn't reach Microsoft to confirm your account for ${Math.floor(days)} days. Connect to the internet and sign in again.`);
    }
    user = null;
    lock(startup ? "" : "Your sign-in has ended. Please sign in again.");
  }

  /** Run once at startup. The app only stays usable for a signed-in staff account. */
  async function start() {
    if (!isTauri) return; // the browser preview used for development has no sign-in
    const saved = auth.currentUser();
    // A saved session lets the app open at once while it's checked in the background.
    if (saved) unlock(saved);
    else lock();
    await verify(true);
    setInterval(() => void verify(false), RECHECK_MS);
  }

  function signOut() {
    auth.signOut();
    user = null;
    lock("You're signed out.");
  }

  return { start, signOut, auth, get user() { return user; } };
}
