// HMAC-signed session tokens (stored in an HttpOnly cookie). Payload is a
// base64url JSON blob; signature is HMAC-SHA256 under SESSION_SECRET.

export interface SessionData {
  /** Google account's stable id ("sub" claim) — the user key. */
  sub: string;
  email: string;
}

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(
  secret: string,
  data: SessionData,
  ttlSeconds: number
): Promise<string> {
  const payload = enc.encode(
    JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })
  );
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), payload);
  return `${b64urlEncode(payload)}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
  secret: string,
  token: string
): Promise<SessionData | null> {
  const [p, s] = token.split(".");
  if (!p || !s) return null;
  try {
    const payload = b64urlDecode(p);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(s),
      payload
    );
    if (!valid) return null;
    const data = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    if (typeof data.exp !== "number" || data.exp < Date.now() / 1000) return null;
    if (typeof data.sub !== "string" || typeof data.email !== "string") return null;
    return { sub: data.sub, email: data.email };
  } catch {
    return null;
  }
}
