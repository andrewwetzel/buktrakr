// Google OAuth 2.0 (authorization code flow) via raw fetch — no SDK.

import type { Env } from "./index";

// drive.file is non-sensitive: the app can only touch files it created,
// and the consent screen can be published without Google verification.
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The stored refresh token was revoked or expired; user must reconnect. */
export class ReconnectRequiredError extends Error {}

export function buildAuthUrl(env: Env, state: string, email: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.APP_URL}/auth/callback`,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Guarantees Google returns a refresh_token even on re-connect.
    prompt: "consent",
    state,
    login_hint: email,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<{ status: number; body: TokenResponse }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as TokenResponse };
}

export async function exchangeCode(
  env: Env,
  code: string
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const { status, body } = await tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${env.APP_URL}/auth/callback`,
    grant_type: "authorization_code",
  });
  if (status !== 200 || !body.access_token) {
    throw new Error(`Code exchange failed (${status}): ${body.error ?? "unknown"}`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null };
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  const { status, body } = await tokenRequest({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
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
