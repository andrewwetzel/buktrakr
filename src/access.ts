// Verification of the Cloudflare Access JWT (Cf-Access-Jwt-Assertion header)
// against the team's public JWKS. Zero dependencies: RS256 via WebCrypto.

import type { Env } from "./index";

interface Jwk extends JsonWebKey {
  kid?: string;
}

// Module-scope cache survives across requests within an isolate.
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJson(b64url: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url)));
}

async function fetchJwks(teamDomain: string): Promise<Jwk[]> {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

async function getJwk(teamDomain: string, kid: string): Promise<Jwk | undefined> {
  let keys =
    jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
      ? jwksCache.keys
      : await fetchJwks(teamDomain);
  let key = keys.find((k) => k.kid === kid);
  if (!key) {
    // Unknown kid may mean Cloudflare rotated keys since we cached.
    keys = await fetchJwks(teamDomain);
    key = keys.find((k) => k.kid === kid);
  }
  return key;
}

/**
 * Returns the authenticated user's email (lowercased), or null if the token
 * is missing, malformed, badly signed, expired, or minted for another app.
 */
export async function verifyAccessJwt(token: string, env: Env): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = decodeJson(parts[0]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

    const jwk = await getJwk(env.ACCESS_TEAM_DOMAIN, header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;

    const claims = decodeJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    // aud must contain THIS app's tag, else a JWT for another Access app on
    // the same team would be accepted here.
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (typeof claims.exp !== "number" || claims.exp < now - 60) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
    if (typeof claims.email !== "string" || !claims.email) return null;

    return claims.email.toLowerCase();
  } catch {
    return null;
  }
}
