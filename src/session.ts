// Encrypted session cookie — the app's only state. AES-256-GCM under a key
// derived from SESSION_SECRET; GCM's auth tag also guarantees integrity.
// Confidentiality matters here because the payload carries the user's Google
// refresh token: nothing is stored server-side at all.

export interface SessionData {
  /** Google account's stable id ("sub" claim) — the user key. */
  sub: string;
  email: string;
  refreshToken: string;
  docId: string | null;
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

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function createSessionToken(
  secret: string,
  data: SessionData,
  ttlSeconds: number
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(
    JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(secret),
    plaintext
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

export async function verifySessionToken(
  secret: string,
  token: string
): Promise<SessionData | null> {
  const [ivPart, ctPart] = token.split(".");
  if (!ivPart || !ctPart) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(ivPart) },
      await aesKey(secret),
      b64urlDecode(ctPart)
    );
    const data = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    if (typeof data.exp !== "number" || data.exp < Date.now() / 1000) return null;
    if (typeof data.sub !== "string" || typeof data.email !== "string") return null;
    if (typeof data.refreshToken !== "string" || !data.refreshToken) return null;
    return {
      sub: data.sub,
      email: data.email,
      refreshToken: data.refreshToken,
      docId: typeof data.docId === "string" ? data.docId : null,
    };
  } catch {
    return null;
  }
}
