// Google OAuth 2.0 (authorization code flow) via raw fetch — no SDK.
// Google sign-in doubles as the app's login: openid/email supply identity,
// drive.file lets the app write to the one doc it creates.

import type { Env } from "./index";

// drive.file is non-sensitive: the app can only touch files it created,
// and the consent screen can be published without Google verification.
const SCOPES = "openid email https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The stored refresh token was revoked or expired; user must reconnect. */
export class ReconnectRequiredError extends Error {}

// Secrets pasted into the dashboard often pick up a stray newline or space;
// Google then rejects the client as unknown (invalid_client).
const clientId = (env: Env): string => env.GOOGLE_CLIENT_ID.trim();
const clientSecret = (env: Env): string => env.GOOGLE_CLIENT_SECRET.trim();

export interface IdClaims {
  sub: string;
  email: string | null;
}

export function buildAuthUrl(
  env: Env,
  redirectUri: string,
  state: string,
  forceConsent: boolean
): string {
  const params = new URLSearchParams({
    client_id: clientId(env),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    state,
  });
  // Only force the consent screen when we actually need a fresh refresh
  // token — returning users otherwise sign in without re-consenting.
  if (forceConsent) params.set("prompt", "consent");
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  error?: string;
}

async function tokenRequest(
  params: Record<string, string>
): Promise<{ status: number; body: TokenResponse }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as TokenResponse };
}

// The id_token arrives directly from Google's token endpoint over TLS, so
// its signature does not need to be re-verified here.
function parseIdToken(idToken: string): IdClaims | null {
  try {
    let b64 = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    return {
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email.toLowerCase() : null,
    };
  } catch {
    return null;
  }
}

export async function exchangeCode(
  env: Env,
  redirectUri: string,
  code: string
): Promise<{ refreshToken: string | null; claims: IdClaims | null }> {
  const { status, body } = await tokenRequest({
    code,
    client_id: clientId(env),
    client_secret: clientSecret(env),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (status !== 200 || !body.id_token) {
    throw new Error(`Code exchange failed (${status}): ${body.error ?? "unknown"}`);
  }
  return {
    refreshToken: body.refresh_token ?? null,
    claims: parseIdToken(body.id_token),
  };
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  const { status, body } = await tokenRequest({
    refresh_token: refreshToken,
    client_id: clientId(env),
    client_secret: clientSecret(env),
    grant_type: "refresh_token",
  });
  if (status === 400 && body.error === "invalid_grant") {
    throw new ReconnectRequiredError();
  }
  if (status !== 200 || !body.access_token) {
    throw new Error(`Token refresh failed (${status}): ${body.error ?? "unknown"}`);
  }
  return body.access_token;
}

export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Best-effort: the KV record is cleared regardless.
  }
}
