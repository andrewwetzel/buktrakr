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
  appendEntriesBulk,
  appendEntry,
  createDoc,
  docUrl,
  findFile,
  getDocText,
  parseEntries,
  parseEntriesFull,
  listAppFiles,
  renameFile,
  restyleDoc,
  setFileProps,
  DocNotFoundError,
  DOC_MIME,
  DOC_TITLE,
  PROP_ACTIVE,
  PROP_STYLE,
  STYLE_IDS,
  type Entry,
  type FullEntry,
  type ParsedEntry,
  type StyleId,
} from "./docs";
import {
  appendRow,
  appendRows,
  applySheetStyle,
  createSheet,
  readRows,
  rowsToText,
  sheetUrl,
  SHEET_MIME,
} from "./sheets";
import type { DestMode } from "./session";

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

/** Link to the active destination file, if known. */
function destUrl(session: SessionData): string | null {
  if (session.mode === "sheet") {
    return session.sheetId ? sheetUrl(session.sheetId) : null;
  }
  return session.docId ? docUrl(session.docId) : null;
}

/**
 * Reads the active destination (doc or sheet): its parsed entries plus a
 * plain-text rendering for the export. Null when no (surviving) file exists.
 */
async function readDestination(
  session: SessionData,
  accessToken: string,
): Promise<{ id: string; text: string; entries: ParsedEntry[] } | null> {
  try {
    if (session.mode === "sheet") {
      const id = session.sheetId ?? (await findFile(accessToken, SHEET_MIME));
      if (!id) return null;
      const rows = await readRows(accessToken, id);
      return { id, text: rowsToText(rows), entries: rows };
    }
    const id = session.docId ?? (await findFile(accessToken, DOC_MIME));
    if (!id) return null;
    const text = await getDocText(accessToken, id);
    return { id, text, entries: parseEntries(text) };
  } catch (err) {
    if (err instanceof DocNotFoundError) return null;
    throw err;
  }
}

export interface Settings {
  mode: DestMode;
  docName: string;
  style: StyleId;
  /** Opt-in: retroactively restyle / migrate existing entries. */
  applyToExisting: boolean;
}

/**
 * Settings recovered from Drive file metadata — the cross-device source of
 * truth, read back at each sign-in. Null fields mean "nothing stored".
 */
interface Discovered {
  docId: string | null;
  sheetId: string | null;
  mode: DestMode | null;
  docName: string | null;
  style: StyleId | null;
}

async function discoverState(accessToken: string): Promise<Discovered> {
  const files = await listAppFiles(accessToken);
  const doc = files.find((f) => f.mimeType === DOC_MIME) ?? null;
  const sheet = files.find((f) => f.mimeType === SHEET_MIME) ?? null;
  const flagged =
    files.find((f) => f.appProperties?.[PROP_ACTIVE] === "1") ?? null;
  const nameSource = flagged ?? doc ?? sheet;
  const styleRaw = flagged?.appProperties?.[PROP_STYLE];
  return {
    docId: doc?.id ?? null,
    sheetId: sheet?.id ?? null,
    mode: flagged ? (flagged.mimeType === SHEET_MIME ? "sheet" : "doc") : null,
    docName: nameSource?.name ?? null,
    style: STYLE_IDS.includes(styleRaw as StyleId)
      ? (styleRaw as StyleId)
      : null,
  };
}

/** Marks a file as the active destination, recording the style with it. */
async function markActive(
  accessToken: string,
  fileId: string,
  style: StyleId,
): Promise<void> {
  await setFileProps(accessToken, fileId, {
    [PROP_ACTIVE]: "1",
    [PROP_STYLE]: style,
  });
}

export function validateSettings(body: unknown): Settings | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.mode !== "doc" && b.mode !== "sheet") return null;
  if (!STYLE_IDS.includes(b.style as StyleId)) return null;
  if (typeof b.docName !== "string" || b.docName.length > 128) return null;
  const docName = b.docName.replace(/\s+/g, " ").trim() || DOC_TITLE;
  return {
    mode: b.mode,
    docName,
    style: b.style as StyleId,
    applyToExisting: b.applyToExisting === true,
  };
}

const entryKey = (e: { title: string; date: string }): string =>
  `${e.title.toLowerCase().trim()}|${e.date}`;

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
  // What's being reviewed: a single book (default), a whole series, or an
  // author. Series/author entries carry a marker in the stored title so the
  // doc/sheet format (and every parser) stays unchanged.
  const kind =
    b.kind === "series" || b.kind === "author" ? b.kind : ("book" as const);
  let title: string | null;
  let author: string | null;
  if (kind === "author") {
    const name = requiredStr(b.author, 500);
    title = name ? `${name} (author)` : null;
    author = "";
  } else {
    const base = requiredStr(b.title, 500);
    title = base ? (kind === "series" ? `${base} (series)` : base) : null;
    author = requiredStr(b.author, 500);
  }
  const rating = b.rating;
  const liked = optionalStr(b.liked);
  const disliked = optionalStr(b.disliked);
  const notes = optionalStr(b.notes);
  if (
    !title ||
    author === null ||
    (kind !== "author" && !author) ||
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
  // ISBN and cover only make sense for a single book.
  const isbn =
    kind === "book" && typeof b.isbn === "string" && b.isbn.length <= 32
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
  if (
    kind === "book" &&
    typeof b.coverUrl === "string" &&
    b.coverUrl.length <= 500
  ) {
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
            docUrl: destUrl(session),
            settings: {
              mode: session.mode,
              docName: session.docName,
              style: session.style,
            },
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

          const { accessToken, refreshToken, claims } = await exchangeCode(
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

          // Cross-device settings sync: read the state stored on the user's
          // Drive files. Best-effort — sign-in must not fail on a Drive blip.
          let disc: Discovered | null = null;
          if (accessToken) {
            try {
              disc = await discoverState(accessToken);
            } catch {
              disc = null;
            }
          }

          return redirect(`${url.origin}/`, [
            clearState,
            await sessionCookie(env, {
              sub: claims.sub,
              email: claims.email ?? "",
              refreshToken: effectiveToken,
              docId: disc?.docId ?? carried?.docId ?? null,
              sheetId: disc?.sheetId ?? carried?.sheetId ?? null,
              mode: disc?.mode ?? carried?.mode ?? "doc",
              docName: disc?.docName ?? carried?.docName ?? DOC_TITLE,
              style: disc?.style ?? carried?.style ?? "classic",
            }),
          ]);
        }

        case "POST /api/entries": {
          const auth = await requireAuth(request, env);
          if (auth instanceof Response) return auth;
          const { session, accessToken } = auth;
          const entry = validateEntry(await request.json().catch(() => null));
          if (!entry) return json({ error: "invalid_entry" }, 400);

          const sheetMode = session.mode === "sheet";
          const mime = sheetMode ? SHEET_MIME : DOC_MIME;
          const create = async (): Promise<string> => {
            const id = sheetMode
              ? await createSheet(accessToken, session.docName, session.style)
              : await createDoc(accessToken, session.docName);
            // Record the active flag + style so other devices adopt this
            // file at sign-in. Best-effort.
            await markActive(accessToken, id, session.style).catch(() => {});
            return id;
          };
          const append = (id: string): Promise<void> =>
            sheetMode
              ? appendRow(accessToken, id, entry)
              : appendEntry(accessToken, id, entry, session.style);

          // Cookie may not know the destination (fresh browser): find the one
          // this app created earlier, or create it.
          let fileId =
            (sheetMode ? session.sheetId : session.docId) ??
            (await findFile(accessToken, mime)) ??
            (await create());
          try {
            await append(fileId);
          } catch (err) {
            if (!(err instanceof DocNotFoundError)) throw err;
            // Stale id (file deleted in Drive): rediscover or recreate, retry once.
            fileId = (await findFile(accessToken, mime)) ?? (await create());
            await append(fileId);
          }

          // Re-issue the cookie so it remembers the file (and rolls the expiry).
          const updated: SessionData = sheetMode
            ? { ...session, sheetId: fileId }
            : { ...session, docId: fileId };
          return json({ ok: true, docUrl: destUrl(updated) }, 200, [
            await sessionCookie(env, updated),
          ]);
        }

        case "POST /api/settings": {
          const auth = await requireAuth(request, env);
          if (auth instanceof Response) return auth;
          const { session, accessToken } = auth;
          const settings = validateSettings(
            await request.json().catch(() => null),
          );
          if (!settings) return json({ error: "invalid_settings" }, 400);

          const { applyToExisting, ...prefs } = settings;
          const updated: SessionData = { ...session, ...prefs };
          const toSheet = prefs.mode === "sheet";
          const modeSwitched = session.mode !== prefs.mode;
          const styleChanged = session.style !== prefs.style;

          // Migration source: the OLD mode's entries (read-only, opt-in).
          let source: FullEntry[] = [];
          if (applyToExisting && modeSwitched) {
            try {
              if (session.mode === "doc") {
                const srcId =
                  session.docId ?? (await findFile(accessToken, DOC_MIME));
                if (srcId) {
                  source = parseEntriesFull(
                    await getDocText(accessToken, srcId),
                  );
                  updated.docId = srcId;
                }
              } else {
                const srcId =
                  session.sheetId ?? (await findFile(accessToken, SHEET_MIME));
                if (srcId) {
                  source = await readRows(accessToken, srcId);
                  updated.sheetId = srcId;
                }
              }
            } catch (err) {
              if (!(err instanceof DocNotFoundError)) throw err;
            }
          }

          // Apply the name + active flag + style to the destination file if
          // it exists (rediscover it if this cookie doesn't know it); create
          // it right away when a migration needs somewhere to land.
          const mime = toSheet ? SHEET_MIME : DOC_MIME;
          let fileId =
            (toSheet ? updated.sheetId : updated.docId) ??
            (await findFile(accessToken, mime));
          let createdNow = false;
          if (!fileId && source.length > 0) {
            fileId = toSheet
              ? await createSheet(accessToken, prefs.docName, prefs.style)
              : await createDoc(accessToken, prefs.docName);
            createdNow = true;
          }
          if (fileId) {
            try {
              await renameFile(accessToken, fileId, prefs.docName);
              await markActive(accessToken, fileId, prefs.style);
              if (toSheet) updated.sheetId = fileId;
              else updated.docId = fileId;
            } catch (err) {
              if (!(err instanceof DocNotFoundError)) throw err;
              // Stale id — forget it; the next submission recreates the file.
              if (toSheet) updated.sheetId = null;
              else updated.docId = null;
              fileId = null;
            }
          }

          // Retroactive work (opt-in): copy entries across on a mode switch,
          // restyle existing doc entries on a style change. Append/format
          // only — never deletes or edits text. Best-effort: a failure here
          // must not lose the settings save itself.
          let migrated = 0;
          let restyled = 0;
          let retroFailed = false;
          try {
            if (fileId && source.length > 0) {
              if (toSheet) {
                const existing = new Set(
                  (await readRows(accessToken, fileId)).map(entryKey),
                );
                const missing = source.filter(
                  (e) => !existing.has(entryKey(e)),
                );
                await appendRows(accessToken, fileId, missing);
                migrated = missing.length;
              } else {
                const existing = new Set(
                  parseEntries(await getDocText(accessToken, fileId)).map(
                    entryKey,
                  ),
                );
                const missing = source.filter(
                  (e) => !existing.has(entryKey(e)),
                );
                await appendEntriesBulk(
                  accessToken,
                  fileId,
                  missing.map((e) => ({ ...e, coverUrl: "" })),
                  prefs.style,
                );
                migrated = missing.length;
              }
            }
            if (
              fileId &&
              !toSheet &&
              applyToExisting &&
              (styleChanged || modeSwitched)
            ) {
              restyled = await restyleDoc(accessToken, fileId, prefs.style);
            }
            // Sheet themes are whole-sheet chrome (header, banding, widths,
            // wrapping) — a saved-but-unapplied theme would mean nothing, so
            // apply on any theme/mode change. Sheets has version history too.
            if (
              fileId &&
              toSheet &&
              !createdNow &&
              (styleChanged || modeSwitched)
            ) {
              await applySheetStyle(accessToken, fileId, prefs.style);
            }
          } catch (err) {
            console.error("retroactive settings step failed:", err);
            retroFailed = true;
          }

          // The other-mode file, if any, loses the active flag so sign-ins
          // elsewhere adopt the right destination. Best-effort.
          const otherId = toSheet ? updated.docId : updated.sheetId;
          if (otherId) {
            await setFileProps(accessToken, otherId, {
              [PROP_ACTIVE]: null,
            }).catch(() => {});
          }

          return json(
            {
              ok: true,
              settings: prefs,
              migrated,
              restyled,
              retroFailed,
              docUrl: destUrl(updated),
            },
            200,
            [await sessionCookie(env, updated)],
          );
        }

        case "GET /api/recent": {
          const auth = await requireAuth(request, env);
          if (auth instanceof Response) return auth;
          const dest = await readDestination(auth.session, auth.accessToken);
          const entries = dest?.entries ?? [];
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
          const dest = await readDestination(auth.session, auth.accessToken);
          let log = dest?.text.trim() ?? "";
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
