# BukTrakr

A tiny private web app for logging book reviews. You sign in through a
Cloudflare Access policy, fill in a form (title, author, rating out of 10, what
you liked / didn't like), and each entry is appended to a Google Doc **in your
own Google Drive**. Every person allowed by the Access policy connects their own
Google account once; after that their reviews land in their own doc
("BukTrakr — Book Reviews"), which the app creates for them.

Deployment is fully dashboard-driven: Cloudflare's git integration builds and
deploys the Worker from the `main` branch of this repo on every push — no local
clone, wrangler, or build step required.

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

### 1. Google Cloud (done once for the whole app)

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
   **Web application**. Authorized redirect URI:
   `https://YOUR-DOMAIN/auth/callback`
   (add `http://localhost:8787/auth/callback` too only if you ever want to run
   the app locally). Note the client ID and client secret.

### 2. Cloudflare — everything from the dashboard

1. **KV namespace**: dash.cloudflare.com → **Storage & Databases → KV →
   Create namespace** (name it e.g. `buktrakr`). Copy its **namespace ID** and
   put it into `wrangler.jsonc` (`kv_namespaces[0].id`). No clone needed —
   edit the file straight on GitHub (open `wrangler.jsonc` → pencil icon →
   commit to `main`), or ask Claude to commit it for you. Do this **before**
   step 2 so the first deploy succeeds.
2. **Connect the repo**: **Workers & Pages → Create → Workers → Import a
   repository** → connect your GitHub account → pick `andrewwetzel/buktrakr`,
   branch `main`. The defaults are fine — Cloudflare runs
   `npx wrangler deploy`, which reads `wrangler.jsonc` from the repo root.
   From now on **every push to `main` auto-deploys**.
3. **Variables and secrets**: your Worker → **Settings → Variables and
   Secrets**. Add:
   - **Secret** `GOOGLE_CLIENT_ID` — from Google step 5
   - **Secret** `GOOGLE_CLIENT_SECRET` — from Google step 5
   - **Text** `APP_URL` — `https://YOUR-DOMAIN` (no trailing slash)
   - **Text** `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` — filled in step 5;
     you can create them with placeholder values for now.

   These live only in the dashboard (`keep_vars` in `wrangler.jsonc` stops
   deploys from overwriting them), so you can edit them any time without
   touching the repo.
4. **Custom domain**: your Worker → **Settings → Domains & Routes → Add →
   Custom domain** → `books.yourdomain.com` (any hostname on a zone in your
   account). Cloudflare creates the DNS record and certificate automatically.
5. **Zero Trust Access**: one.dash.cloudflare.com → **Access →
   Applications → Add an application → Self-hosted**:
   - Application domain = the hostname from step 4; session duration to taste
     (e.g. 1 week).
   - Add an **Allow** policy including the emails (or email domain) of
     everyone who may use the app. The default One-Time PIN login works out of
     the box; add Google SSO as an identity provider if you prefer.
   - Do **not** add a bypass for `/auth/callback` — the browser carries the
     Access cookie through Google's redirect, so it passes through normally.
6. Back in the Worker's **Variables and Secrets**, set the real values:
   - `ACCESS_AUD` = the Access application's **AUD tag** (application →
     Overview / Basic information).
   - `ACCESS_TEAM_DOMAIN` = your team domain, e.g.
     `yourteam.cloudflareaccess.com` (Zero Trust → Settings → Custom Pages).

   Saving variables redeploys the Worker immediately — no push needed.

That's it. Visit the hostname, pass the Access login, click **Connect Google
account**, and start logging books. Each new user covered by the policy repeats
only the connect step.

## Making changes

Push (or merge) to `main` and Cloudflare rebuilds and deploys automatically.
Build history and logs are under the Worker's **Deployments** tab.

## Local development (optional)

Not required for deployment, but the app runs fully locally if you ever want
it to:

```sh
cp .dev.vars.example .dev.vars   # fill in Google client ID/secret + your email
npm install
npm run dev                       # http://localhost:8787
```

Access isn't in front of `wrangler dev`, so `.dev.vars` sets `DEV_USER_EMAIL`,
which is used **only when the `Cf-Access-Jwt-Assertion` header is absent**.
Since `DEV_USER_EMAIL` is never configured in production, the bypass cannot
apply there. The full OAuth + Docs flow works locally against the real Google
APIs if you registered the `http://localhost:8787/auth/callback` redirect URI.

## Behavior notes

- **Revoked/expired Google connection** (`invalid_grant`): the API returns
  `409 reconnect_required` and the UI shows the Connect button again. The doc
  ID is kept, so reconnecting resumes the same doc.
- **User deletes the doc in Drive**: the next submission gets a 404 from the
  Docs API; the Worker creates a fresh doc and retries the append once.
- **Wrong Google account**: users may connect a Google account different from
  their Access email — that's allowed; the doc simply lives wherever they
  connected.

## Verifying the deployment

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
