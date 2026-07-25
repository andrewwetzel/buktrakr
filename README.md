# BukTrakr

A tiny web app for logging book reviews. Sign in with Google, fill in a form
(title, author, rating out of 10, what you liked / didn't like), and each
entry is appended to a Google Doc **in your own Google Drive** — the app
creates a "BukTrakr — Book Reviews" doc for you on your first entry and only
ever touches that one doc.

Anyone can use a hosted instance: Google sign-in *is* the login, and every
user's reviews go to their own doc in their own Drive.

## Deploy your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/andrewwetzel/buktrakr)

The button clones this repo into your GitHub account, provisions the KV
namespace in your Cloudflare account, and sets up continuous deploys from
`main`. Two things it can't do for you — a Google OAuth client and three
secrets — are covered below.

### 1. Google Cloud (console.cloud.google.com)

1. Create a project (e.g. `buktrakr`).
2. **APIs & Services → Library**: enable **Google Drive API** and
   **Google Docs API**.
3. **OAuth consent screen**: user type **External**, add the scopes
   `openid`, `.../auth/userinfo.email`, and
   `https://www.googleapis.com/auth/drive.file`.
4. **Publish the consent screen to Production**. All three scopes are
   non-sensitive, so no Google verification review is needed — and Testing
   mode's 7-day refresh-token expiry is avoided.
5. **Credentials → Create credentials → OAuth client ID**, type
   **Web application**. Authorized redirect URI:
   `https://YOUR-HOSTNAME/auth/callback` — that's your
   `<name>.<subdomain>.workers.dev` host, or your custom domain if you add
   one (you can list several, including `http://localhost:8787/auth/callback`
   for local dev). Note the client ID and secret.

### 2. Cloudflare

1. If you didn't use the button: create a KV namespace (**Storage &
   Databases → KV**) and paste its ID into `wrangler.jsonc`
   (`kv_namespaces[0].id`), then connect the repo via **Workers & Pages →
   Create → Workers → Import a repository**. Every push to `main`
   auto-deploys.
2. Your Worker → **Settings → Variables and Secrets** — add three
   **secrets**:
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from step 1.5
   - `SESSION_SECRET` — any long random string (e.g. `openssl rand -base64 32`);
     it signs the session cookies
3. Optional: **Settings → Domains & Routes → Add → Custom domain** to serve
   it from your own hostname (then add that hostname's callback URL to the
   Google OAuth client too).

That's the whole setup. Visit the app, sign in with Google, log a book.

## How it works

- A single **Cloudflare Worker** (no runtime npm dependencies) serves the
  static form (`public/index.html`) and a small JSON API.
- **Google sign-in is the login.** The OAuth flow requests `openid email`
  (identity) plus `drive.file` (Drive access limited to files the app
  created). The Worker keeps users signed in with an HMAC-signed, HttpOnly
  session cookie (`SESSION_SECRET`); the OAuth `state` round-trips through a
  short-lived cookie as CSRF protection.
- **Workers KV** stores one small record per Google account (keyed by the
  stable `sub` id): the refresh token, the doc ID, and the email. On each
  submission the Worker mints a fresh access token, ensures the doc exists
  (recreating it if deleted), and appends a formatted entry via the Docs API.
- Privacy: the `drive.file` scope means the app **cannot see anything in a
  user's Drive except the one doc it created**. Refresh tokens are stored
  unencrypted in KV — acceptable for this scope, and noted here for
  transparency.

## Behavior notes

- **Revoked/expired Google connection** (`invalid_grant`): the API returns
  `409 reconnect_required` and the UI shows a "Reconnect Google" button,
  which re-runs the OAuth flow with `prompt=consent` to get a fresh refresh
  token. The doc ID is kept, so the same doc is resumed.
- **User deletes the doc in Drive**: the next submission gets a 404 from the
  Docs API; the Worker creates a fresh doc and retries the append once.
- **Sign out** clears the session cookie. **Disconnect** (`/api/disconnect`)
  additionally revokes the app's Google access.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in Google client ID/secret
npm install
npm run dev                       # http://localhost:8787
```

Register `http://localhost:8787/auth/callback` as an additional redirect URI
on the Google OAuth client and the full sign-in + Docs flow works locally
against the real Google APIs.

## Verifying a deployment

1. Load the app signed out → the "Sign in with Google" card shows.
2. Sign in → the form appears with your email in the status bar.
3. Submit an entry → "Open reviews doc" links to a doc with a formatted
   entry (heading, italic rating line, bold section labels). A second entry
   appends below the first.
4. `curl -X POST https://YOUR-HOSTNAME/api/entries -d '{}'` with no cookie
   → `401` (the API requires a valid signed session).
5. A second person signs in with their own Google account → their entries
   land in a doc in *their* Drive.
