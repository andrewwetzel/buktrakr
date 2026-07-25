# BukTrakr

A tiny private web app for logging book reviews. You sign in through a
Cloudflare Access policy, fill in a form (title, author, rating out of 10, what
you liked / didn't like), and each entry is appended to a Google Doc **in your
own Google Drive**. Every person allowed by the Access policy connects their own
Google account once; after that their reviews land in their own doc
("BukTrakr — Book Reviews"), which the app creates for them.

## How it works

- A single **Cloudflare Worker** (no runtime npm dependencies) serves the form
  (`public/index.html`) and the API.
- **Cloudflare Access** gates the hostname. The Worker additionally verifies the
  `Cf-Access-Jwt-Assertion` JWT (signature via the team JWKS, plus `iss`/`aud`/
  `exp` claims) so the app can't be reached without a valid Access session —
  `workers_dev` is disabled for the same reason. The JWT's `email` claim is the
  user's identity.
- Each user does a one-time **Google OAuth** connect with only the
  `drive.file` scope — the app can touch *only files it created*, nothing else
  in their Drive. Because that scope is non-sensitive, the OAuth consent screen
  can be published to production without Google's verification review.
- **Workers KV** stores, per user email: the Google refresh token and the doc
  ID. On each submission the Worker mints a fresh access token, ensures the doc
  exists (recreating it if the user deleted it), and appends a formatted entry
  via the Google Docs API.

Note: refresh tokens are stored unencrypted in KV. For a personal tool behind
Access with the minimal `drive.file` scope this is an accepted trade-off.

## One-time setup

### 1. Google Cloud (one project for the whole app)

1. Create a project at https://console.cloud.google.com (e.g. `buktrakr`).
2. **APIs & Services → Library**: enable **Google Drive API** and
   **Google Docs API**.
3. **OAuth consent screen** (Google Auth Platform): user type **External**, app
   name "BukTrakr", your support email. Add the scope
   `https://www.googleapis.com/auth/drive.file`.
4. **Publish the app to Production** (Publishing status → "In production").
   No verification is needed for `drive.file`, and this avoids Testing mode's
   7-day refresh-token expiry.
5. **Credentials → Create credentials → OAuth client ID**, type
   **Web application**. Authorized redirect URIs:
   - `https://YOUR-DOMAIN/auth/callback`
   - `http://localhost:8787/auth/callback` (for local dev)

   Note the client ID and client secret.

### 2. Cloudflare

1. Edit `wrangler.jsonc`: set your hostname in `routes` and `APP_URL`
   (e.g. `books.yourdomain.com` — the zone must be in your Cloudflare account).
2. Create the KV namespace and paste its id into `wrangler.jsonc`:

   ```sh
   npx wrangler kv namespace create KV
   ```

3. Set the Google secrets:

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

4. Deploy (`custom_domain: true` auto-creates the DNS record + cert):

   ```sh
   npm install
   npx wrangler deploy
   ```

5. **Zero Trust dashboard → Access → Applications → Add an application →
   Self-hosted**: application domain = your hostname, session duration to
   taste (e.g. 1 week). Add an **Allow** policy including the emails (or email
   domain) of everyone who may use the app. The default One-Time PIN login
   works out of the box; add Google SSO as an identity provider if you prefer.
   Do **not** add a bypass for `/auth/callback` — the browser carries the
   Access cookie through Google's redirect, so it passes through normally.
6. Copy the Access application's **AUD tag** (app → Overview) into
   `ACCESS_AUD` in `wrangler.jsonc`, and set `ACCESS_TEAM_DOMAIN` to your team
   domain (`yourteam.cloudflareaccess.com`, shown under Zero Trust → Settings).
   Redeploy: `npx wrangler deploy`.

That's it. Visit the hostname, pass the Access login, click **Connect Google
account**, and start logging books. Each new user covered by the policy repeats
only the connect step.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in Google client ID/secret + your email
npm install
npm run dev                       # http://localhost:8787
```

Access isn't in front of `wrangler dev`, so `.dev.vars` sets `DEV_USER_EMAIL`,
which is used **only when the `Cf-Access-Jwt-Assertion` header is absent**.
Since `DEV_USER_EMAIL` is never configured in production, the bypass cannot
apply there. The full OAuth + Docs flow works locally against the real Google
APIs via the `http://localhost:8787/auth/callback` redirect URI.

## Behavior notes

- **Revoked/expired Google connection** (`invalid_grant`): the API returns
  `409 reconnect_required` and the UI shows the Connect button again. The doc
  ID is kept, so reconnecting resumes the same doc.
- **User deletes the doc in Drive**: the next submission gets a 404 from the
  Docs API; the Worker creates a fresh doc and retries the append once.
- **Wrong Google account**: users may connect a Google account different from
  their Access email — that's allowed; the doc simply lives wherever they
  connected.

## Verifying a deployment

1. `curl -I https://YOUR-DOMAIN/` while logged out → 302 to
   `…cloudflareaccess.com` (Access is fronting the app).
2. `curl https://YOUR-DOMAIN/api/status -H "Cf-Access-Jwt-Assertion: bogus"`
   → `403` (the Worker verifies the JWT itself, it doesn't just trust the
   header).
3. In a browser: pass the Access login → Connect Google → submit an entry →
   the "Open reviews doc" link shows a doc with a formatted entry (heading,
   italic rating line, bold section labels). Submit another entry → it appends
   below.
4. Have a second policy-allowed user repeat step 3 — their entries land in a
   doc in *their* Drive.
