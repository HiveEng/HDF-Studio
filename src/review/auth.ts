// Microsoft 365 (Entra ID) sign-in for the review server: checks the ID token each request
// carries, and only lets in accounts from the allowed email domain (e.g. hiveng.ca).
import { createPublicKey, verify } from "node:crypto";

type JsonWebKey = { kty?: string; n?: string; e?: string; kid?: string; [k: string]: unknown };

export interface MicrosoftAuth {
  kind: "microsoft";
  /** Directory (tenant) ID of the organisation, from the Entra app registration. */
  tenant: string;
  /** Application (client) ID of the HDF Studio app registration. */
  clientId: string;
  /** Allowed email domains, e.g. ["hiveng.ca"]. */
  domains: string[];
  /** For tests: supply signing keys instead of downloading them. */
  jwks?: () => Promise<JsonWebKey[]>;
}

export interface User { email: string; name: string }

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function createVerifier(a: MicrosoftAuth) {
  let keys: (JsonWebKey & { kid?: string })[] = [];
  let fetched = 0;
  const load = async (force = false) => {
    if (!force && keys.length && Date.now() - fetched < 6 * 3600_000) return keys;
    if (a.jwks) keys = await a.jwks();
    else {
      const res = await fetch(`https://login.microsoftonline.com/${a.tenant}/discovery/v2.0/keys`);
      if (!res.ok) throw new Error("Could not reach Microsoft to check the sign-in");
      keys = ((await res.json()) as { keys: JsonWebKey[] }).keys;
    }
    fetched = Date.now();
    return keys;
  };
  const issuer = `https://login.microsoftonline.com/${a.tenant}/v2.0`;
  const domains = a.domains.map((d) => d.toLowerCase().replace(/^@/, ""));

  /** Returns the signed-in user, or throws a message suitable for the person. */
  return async function verifyToken(token: string): Promise<User> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Please sign in with your Microsoft work account");
    let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
    try {
      header = JSON.parse(b64(parts[0]).toString("utf8"));
      claims = JSON.parse(b64(parts[1]).toString("utf8"));
    } catch {
      throw new Error("Please sign in with your Microsoft work account");
    }
    if (header.alg !== "RS256") throw new Error("Unsupported sign-in token");
    let key = (await load()).find((k) => (k as { kid?: string }).kid === header.kid);
    if (!key) key = (await load(true)).find((k) => (k as { kid?: string }).kid === header.kid);
    if (!key) throw new Error("Sign-in token from an unknown key");
    const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: key as never, format: "jwk" }), b64(parts[2]));
    if (!ok) throw new Error("Sign-in token is not valid");
    const now = Date.now() / 1000;
    if (claims.iss !== issuer) throw new Error("Signed in to a different organisation");
    if (claims.aud !== a.clientId) throw new Error("Sign-in token is for another app");
    if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("Your sign-in has expired; sign in again");
    if (typeof claims.nbf === "number" && claims.nbf > now + 300) throw new Error("Sign-in token not valid yet");
    const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? "").toLowerCase();
    const domain = email.split("@")[1] ?? "";
    if (!domains.includes(domain)) throw new Error(`Only ${domains.map((d) => "@" + d).join(", ")} accounts can use this review server`);
    return { email, name: String(claims.name ?? email) };
  };
}
