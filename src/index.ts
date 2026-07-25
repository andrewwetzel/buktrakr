import {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  ReconnectRequiredError,
} from "./google";
import { createSessionToken, verifySessionToken, type SessionData } from "./session";
import { appendEntry, createDoc, docUrl, DocNotFoundError, type Entry } from "./docs";

export interface Env {
  KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Any long random string; signs session cookies. */
  SESSION_SECRET: string;
}

interface UserRecord {
  refreshToken: string | null;
  docId: string | null;
  email: string | null;
  connectedAt: string | null;
}

const SESSION_COOKIE = "buktrakr_session";
const STATE_COOKIE = "buktrakr_oauth_state";
const SESSION_TTL_S = 30 * 24 * 60 * 60;

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

// Response.redirect() can't carry Set-Cookie headers.
function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const clearCookie = (name: string): string => setCookie(name, "", 0);

async function getSession(request: Request, env: Env): Promise<SessionData | null> {
  const token = getCookie(request, SESSION_COOKIE);
  return token ? verifySessionToken(env.SESSION_SECRET, token) : null;
}

const userKey = (sub: string): string => `user:${sub}`;

async function getUser(env: Env, sub: string): Promise<UserRecord> {
  const raw = await env.KV.get(userKey(sub));
  if (!raw) return { refreshToken: null, docId: null, email: null, connectedAt: null };
  return JSON.parse(raw) as UserRecord;
}

const putUser = (env: Env, sub: string, record: UserRecord): Promise<void> =>
  env.KV.put(userKey(sub), JSON.stringify(record));

function validateEntry(body: unknown): Entry | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null;
  const title = str(b.title, 500);
  const author = str(b.author, 500);
  const rating = b.rating;
  const text = (v: unknown): string | null =>
    v === undefined || v === null ? "" : typeof v === "string" && v.length <= 5000 ? v : null;
  const liked = text(b.liked);
  const disliked = text(b.disliked);
  if (!title || !author || liked === null || disliked === null) return null;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 10) {
    return null;
  }
  return { title, author, rating, liked, disliked };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    try {
      switch (route) {
        case "GET /api/status": {
          const session = await getSession(request, env);
          if (!session) return json({ signedIn: false });
          const user = await getUser(env, session.sub);
          return json({
            signedIn: true,
            email: session.email,
            connected: Boolean(user.refreshToken),
            docUrl: user.docId ? docUrl(user.docId) : null,
          });
        }

        case "GET /auth/google": {
          const state = crypto.randomUUID();
          const forceConsent = url.searchParams.get("consent") === "1";
          return redirect(
            buildAuthUrl(env, `${url.origin}/auth/callback`, state, forceConsent),
            [setCookie(STATE_COOKIE, state, 600)]
          );
        }

        case "GET /auth/callback": {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const clearState = clearCookie(STATE_COOKIE);
          // CSRF check: state must round-trip through this browser's cookie.
          if (!code || !state || state !== getCookie(request, STATE_COOKIE)) {
            return redirect(`${url.origin}/?error=oauth`, [clearState]);
          }

          const { refreshToken, claims } = await exchangeCode(
            env,
            `${url.origin}/auth/callback`,
            code
          );
          if (!claims) return redirect(`${url.origin}/?error=oauth`, [clearState]);

          const existing = await getUser(env, claims.sub);
          const effectiveToken = refreshToken ?? existing.refreshToken;
          if (!effectiveToken) {
            // Returning user whose stored token is gone: Google only reissues
            // a refresh token when consent is re-prompted.
            return redirect(`${url.origin}/auth/google?consent=1`, [clearState]);
          }
          await putUser(env, claims.sub, {
            refreshToken: effectiveToken,
            docId: existing.docId,
            email: claims.email,
            connectedAt: existing.connectedAt ?? new Date().toISOString(),
          });

          const session = await createSessionToken(
            env.SESSION_SECRET,
            { sub: claims.sub, email: claims.email ?? "" },
            SESSION_TTL_S
          );
          return redirect(`${url.origin}/`, [
            clearState,
            setCookie(SESSION_COOKIE, session, SESSION_TTL_S),
          ]);
        }

        case "POST /api/entries": {
          const session = await getSession(request, env);
          if (!session) return json({ error: "signin_required" }, 401);
          const entry = validateEntry(await request.json().catch(() => null));
          if (!entry) return json({ error: "invalid_entry" }, 400);

          const user = await getUser(env, session.sub);
          if (!user.refreshToken) return json({ error: "reconnect_required" }, 409);

          let accessToken: string;
          try {
            accessToken = await refreshAccessToken(env, user.refreshToken);
          } catch (err) {
            if (err instanceof ReconnectRequiredError) {
              await putUser(env, session.sub, { ...user, refreshToken: null });
              return json({ error: "reconnect_required" }, 409);
            }
            throw err;
          }

          if (!user.docId) {
            user.docId = await createDoc(accessToken);
            await putUser(env, session.sub, user);
          }
          try {
            await appendEntry(accessToken, user.docId, entry);
          } catch (err) {
            if (!(err instanceof DocNotFoundError)) throw err;
            // User deleted the doc in Drive: create a fresh one, retry once.
            user.docId = await createDoc(accessToken);
            await putUser(env, session.sub, user);
            await appendEntry(accessToken, user.docId, entry);
          }
          return json({ ok: true, docUrl: docUrl(user.docId) });
        }

        case "POST /api/signout": {
          return json({ ok: true }, 200, [clearCookie(SESSION_COOKIE)]);
        }

        case "POST /api/disconnect": {
          const session = await getSession(request, env);
          if (!session) return json({ error: "signin_required" }, 401);
          const user = await getUser(env, session.sub);
          if (user.refreshToken) await revokeToken(user.refreshToken);
          await putUser(env, session.sub, { ...user, refreshToken: null });
          return json({ ok: true }, 200, [clearCookie(SESSION_COOKIE)]);
        }

        default:
          return json({ error: "not_found" }, 404);
      }
    } catch (err) {
      console.error(`${route} failed:`, err);
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
