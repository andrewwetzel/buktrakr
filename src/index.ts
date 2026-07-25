import { verifyAccessJwt } from "./access";
import {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  ReconnectRequiredError,
} from "./google";
import { appendEntry, createDoc, docUrl, DocNotFoundError, type Entry } from "./docs";

export interface Env {
  KV: KVNamespace;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  APP_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Local dev only (.dev.vars). Never set in production. */
  DEV_USER_EMAIL?: string;
}

interface UserRecord {
  refreshToken: string | null;
  docId: string | null;
  connectedAt: string | null;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function resolveEmail(request: Request, env: Env): Promise<string | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token) return verifyAccessJwt(token, env);
  // Dev bypass: only when the Access header is absent AND the dev var is set,
  // which is never the case in production.
  if (env.DEV_USER_EMAIL) return env.DEV_USER_EMAIL.toLowerCase();
  return null;
}

const userKey = (email: string): string => `user:${email}`;

async function getUser(env: Env, email: string): Promise<UserRecord> {
  const raw = await env.KV.get(userKey(email));
  if (!raw) return { refreshToken: null, docId: null, connectedAt: null };
  return JSON.parse(raw) as UserRecord;
}

const putUser = (env: Env, email: string, record: UserRecord): Promise<void> =>
  env.KV.put(userKey(email), JSON.stringify(record));

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

    const email = await resolveEmail(request, env);
    if (!email) return json({ error: "unauthorized" }, 403);

    try {
      switch (route) {
        case "GET /api/status": {
          const user = await getUser(env, email);
          return json({
            email,
            connected: Boolean(user.refreshToken),
            docUrl: user.docId ? docUrl(user.docId) : null,
          });
        }

        case "GET /auth/google": {
          const state = crypto.randomUUID();
          await env.KV.put(`state:${state}`, email, { expirationTtl: 600 });
          return Response.redirect(buildAuthUrl(env, state, email), 302);
        }

        case "GET /auth/callback": {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          if (!code || !state) return Response.redirect(`${env.APP_URL}/?error=oauth`, 302);
          // CSRF check: the state must have been minted for this same user.
          const stateEmail = await env.KV.get(`state:${state}`);
          await env.KV.delete(`state:${state}`);
          if (stateEmail !== email) return Response.redirect(`${env.APP_URL}/?error=state`, 302);

          const { refreshToken } = await exchangeCode(env, code);
          if (!refreshToken) {
            return Response.redirect(`${env.APP_URL}/?error=no_refresh_token`, 302);
          }
          const user = await getUser(env, email);
          await putUser(env, email, {
            refreshToken,
            docId: user.docId,
            connectedAt: new Date().toISOString(),
          });
          return Response.redirect(`${env.APP_URL}/`, 302);
        }

        case "POST /api/entries": {
          const entry = validateEntry(await request.json().catch(() => null));
          if (!entry) return json({ error: "invalid_entry" }, 400);

          const user = await getUser(env, email);
          if (!user.refreshToken) return json({ error: "reconnect_required" }, 409);

          let accessToken: string;
          try {
            accessToken = await refreshAccessToken(env, user.refreshToken);
          } catch (err) {
            if (err instanceof ReconnectRequiredError) {
              await putUser(env, email, { ...user, refreshToken: null });
              return json({ error: "reconnect_required" }, 409);
            }
            throw err;
          }

          if (!user.docId) {
            user.docId = await createDoc(accessToken);
            await putUser(env, email, user);
          }
          try {
            await appendEntry(accessToken, user.docId, entry);
          } catch (err) {
            if (!(err instanceof DocNotFoundError)) throw err;
            // User deleted the doc in Drive: create a fresh one, retry once.
            user.docId = await createDoc(accessToken);
            await putUser(env, email, user);
            await appendEntry(accessToken, user.docId, entry);
          }
          return json({ ok: true, docUrl: docUrl(user.docId) });
        }

        case "POST /api/disconnect": {
          const user = await getUser(env, email);
          if (user.refreshToken) await revokeToken(user.refreshToken);
          await putUser(env, email, { ...user, refreshToken: null });
          return json({ ok: true });
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
