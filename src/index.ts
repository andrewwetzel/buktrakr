import {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  ReconnectRequiredError,
} from "./google";
import {
  createSessionToken,
  verifySessionToken,
  type SessionData,
} from "./session";
import {
  appendEntry,
  createDoc,
  docUrl,
  findDoc,
  getDocText,
  parseEntries,
  DocNotFoundError,
  type Entry,
} from "./docs";

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Any long random string; encrypts session cookies. */
  SESSION_SECRET: string;
}

// __Host- prefix: browsers reject these cookies unless Secure, Path=/, and
// host-only — blocks sibling-subdomain cookie planting on custom domains.
const SESSION_COOKIE = "__Host-buktrakr_session";
const STATE_COOKIE = "__Host-buktrakr_oauth_state";
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
    if (eq > 0 && part.slice(0, eq).trim() === name)
      return part.slice(eq + 1).trim();
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const clearCookie = (name: string): string => setCookie(name, "", 0);

async function getSession(
  request: Request,
  env: Env,
): Promise<SessionData | null> {
  const token = getCookie(request, SESSION_COOKIE);
  return token ? verifySessionToken(env.SESSION_SECRET, token) : null;
}

const sessionCookie = async (env: Env, data: SessionData): Promise<string> =>
  setCookie(
    SESSION_COOKIE,
    await createSessionToken(env.SESSION_SECRET, data, SESSION_TTL_S),
    SESSION_TTL_S,
  );

/**
 * Session gate + Google access token, or the error Response to return:
 * missing/invalid session → 401, revoked refresh token → 409.
 */
async function requireAuth(
  request: Request,
  env: Env,
): Promise<{ session: SessionData; accessToken: string } | Response> {
  const session = await getSession(request, env);
  if (!session) return json({ error: "signin_required" }, 401);
  try {
    return {
      session,
      accessToken: await refreshAccessToken(env, session.refreshToken),
    };
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return json({ error: "reconnect_required" }, 409);
    }
    throw err;
  }
}

/** The user's doc id and full text, or null when there is no (surviving) doc. */
async function readUserDoc(
  session: SessionData,
  accessToken: string,
): Promise<{ docId: string; text: string } | null> {
  const docId = session.docId ?? (await findDoc(accessToken));
  if (!docId) return null;
  try {
    return { docId, text: await getDocText(accessToken, docId) };
  } catch (err) {
    if (err instanceof DocNotFoundError) return null;
    throw err;
  }
}

export function validateEntry(body: unknown): Entry | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  // Required single-line field: whitespace (incl. newlines) collapsed so a
  // pasted multiline title can't span doc paragraphs or confuse parseEntries.
  const requiredStr = (v: unknown, max: number): string | null => {
    if (typeof v !== "string" || v.length > max) return null;
    const collapsed = v.replace(/\s+/g, " ").trim();
    return collapsed.length > 0 ? collapsed : null;
  };
  // Optional multi-line field: absent means empty, oversized means invalid.
  const optionalStr = (v: unknown): string | null =>
    v === undefined || v === null
      ? ""
      : typeof v === "string" && v.length <= 5000
        ? v.trim()
        : null;
  const title = requiredStr(b.title, 500);
  const author = requiredStr(b.author, 500);
  const rating = b.rating;
  const liked = optionalStr(b.liked);
  const disliked = optionalStr(b.disliked);
  const notes = optionalStr(b.notes);
  if (
    !title ||
    !author ||
    liked === null ||
    disliked === null ||
    notes === null
  )
    return null;
  if (
    typeof rating !== "number" ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 10
  ) {
    return null;
  }
  const isbn =
    typeof b.isbn === "string" && b.isbn.length <= 32
      ? b.isbn.replace(/[^0-9Xx-]/g, "")
      : "";
  // "Date read" — lenient: anything malformed falls back to today.
  let date = new Date().toISOString().slice(0, 10);
  if (typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    const parsed = new Date(b.date + "T00:00:00Z");
    if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 1900)
      date = b.date;
  }
  // Only cover URLs from the book APIs may be embedded into users' docs.
  let coverUrl = "";
  if (typeof b.coverUrl === "string" && b.coverUrl.length <= 500) {
    try {
      const u = new URL(b.coverUrl);
      const host = u.hostname;
      const allowedHost =
        host === "books.google.com" ||
        host === "covers.openlibrary.org" ||
        host.endsWith(".googleusercontent.com") ||
        host.endsWith(".gstatic.com");
      if (u.protocol === "https:" && allowedHost) coverUrl = u.toString();
    } catch {
      // Not a URL — ignore.
    }
  }
  return {
    title,
    author,
    rating,
    date,
    isbn,
    coverUrl,
    liked,
    disliked,
    notes,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    // CSRF defense-in-depth beyond SameSite=Lax: cross-origin POSTs carry an
    // Origin header that won't match ours.
    if (request.method === "POST") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin)
        return json({ error: "forbidden" }, 403);
    }

    try {
      switch (route) {
        case "GET /api/status": {
          const session = await getSession(request, env);
          if (!session) return json({ signedIn: false });
          return json({
            signedIn: true,
            email: session.email,
            docUrl: session.docId ? docUrl(session.docId) : null,
          });
        }

        case "GET /auth/google": {
          const missing = (
            [
              "GOOGLE_CLIENT_ID",
              "GOOGLE_CLIENT_SECRET",
              "SESSION_SECRET",
            ] as const
          ).filter((k) => !env[k] || !env[k].trim());
          if (missing.length > 0) {
            return new Response(
              `Server misconfigured: the ${missing.join(", ")} secret${missing.length > 1 ? "s are" : " is"} not set.\n` +
                `Add ${missing.length > 1 ? "them" : "it"} in the Cloudflare dashboard under ` +
                `your Worker -> Settings -> Variables and Secrets (type: Secret).`,
              { status: 500, headers: { "Content-Type": "text/plain" } },
            );
          }
          const state = crypto.randomUUID();
          const forceConsent = url.searchParams.get("consent") === "1";
          return redirect(
            buildAuthUrl(
              env,
              `${url.origin}/auth/callback`,
              state,
              forceConsent,
            ),
            [setCookie(STATE_COOKIE, state, 600)],
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
            code,
          );
          if (!claims)
            return redirect(`${url.origin}/?error=oauth`, [clearState]);

          // Google only returns a refresh token when consent was prompted;
          // fall back to the one in this browser's still-valid session.
          const prior = await getSession(request, env);
          const carried = prior?.sub === claims.sub ? prior : null;
          const effectiveToken = refreshToken ?? carried?.refreshToken;
          if (!effectiveToken) {
            return redirect(`${url.origin}/auth/google?consent=1`, [
              clearState,
            ]);
          }

          return redirect(`${url.origin}/`, [
            clearState,
            await sessionCookie(env, {
              sub: claims.sub,
              email: claims.email ?? "",
              refreshToken: effectiveToken,
              docId: carried?.docId ?? null,
            }),
          ]);
        }

        case "POST /api/entries": {
          const auth = await requireAuth(request, env);
          if (auth instanceof Response) return auth;
          const { session, accessToken } = auth;
          const entry = validateEntry(await request.json().catch(() => null));
          if (!entry) return json({ error: "invalid_entry" }, 400);

          // Cookie may not know the doc (fresh browser): find the one this
          // app created earlier, or create it.
          let docId =
            session.docId ??
            (await findDoc(accessToken)) ??
            (await createDoc(accessToken));
          try {
            await appendEntry(accessToken, docId, entry);
          } catch (err) {
            if (!(err instanceof DocNotFoundError)) throw err;
            // Stale id (doc deleted in Drive): rediscover or recreate, retry once.
            docId =
              (await findDoc(accessToken)) ?? (await createDoc(accessToken));
            await appendEntry(accessToken, docId, entry);
          }

          // Re-issue the cookie so it remembers the doc (and rolls the expiry).
          return json({ ok: true, docUrl: docUrl(docId) }, 200, [
            await sessionCookie(env, { ...session, docId }),
          ]);
        }

        case "GET /api/recent": {
          const auth = await requireAuth(request, env);
          if (auth instanceof Response) return auth;
          const doc = await readUserDoc(auth.session, auth.accessToken);
          if (!doc) return json({ entries: [], stats: null });

          const entries = parseEntries(doc.text);
          if (entries.length === 0) return json({ entries: [], stats: null });
          const year = new Date().toISOString().slice(0, 4);
          const stats = {
            total: entries.length,
            thisYear: entries.filter((e) => e.date.startsWith(year)).length,
            avgRating:
              Math.round(
                (entries.reduce((s, e) => s + e.rating, 0) / entries.length) *
                  10,
              ) / 10,
          };
          return json({ entries, stats });
        }

        case "GET /api/export": {
          const auth = await requireAuth(request, env);
          if (auth instanceof Response) return auth;
          const doc = await readUserDoc(auth.session, auth.accessToken);
          let log = doc?.text.trim() ?? "";
          if (!log) return json({ error: "no_doc" }, 404);

          // Keep the prompt pasteable: trim to the most recent entries.
          const MAX_LOG_CHARS = 15000;
          if (log.length > MAX_LOG_CHARS) {
            log = "(earlier entries omitted)\n…" + log.slice(-MAX_LOG_CHARS);
          }
          const prompt =
            "Below is my personal book review log — titles, authors, ratings out of 10, " +
            "and what I thought of each (The Good / The Bad / The Other). Based on my " +
            "tastes, please suggest 8–10 books or authors I'd likely enjoy, with a " +
            "sentence for each on why it fits me.\n\n---\n\n" +
            log;
          return json({ prompt });
        }

        case "POST /api/signout": {
          return json({ ok: true }, 200, [clearCookie(SESSION_COOKIE)]);
        }

        case "POST /api/disconnect": {
          const session = await getSession(request, env);
          if (!session) return json({ error: "signin_required" }, 401);
          await revokeToken(session.refreshToken);
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
