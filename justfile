# BukTrakr — common commands. Run `just` to list them.
# Deployment is dashboard-driven (push to main auto-deploys via Cloudflare's
# git integration); these recipes are for optional local dev. Run `just setup`
# for the one-time setup checklist (full detail in README.md).

set shell := ["bash", "-cu"]

default:
    @just --list

# Install dependencies
install:
    npm install

# Run the local dev server at http://localhost:8787 (copy .dev.vars.example to .dev.vars first)
dev:
    npx wrangler dev

# Typecheck the Worker source
check:
    npm run typecheck

# Deploy manually (normally unnecessary — pushing to main auto-deploys)
deploy:
    npx wrangler deploy

# Tail live production logs
logs:
    npx wrangler tail

# Show the stored record for a user, e.g. `just kv-user you@example.com`
kv-user email:
    npx wrangler kv key get "user:{{email}}" --binding KV --remote

# Print the one-time setup checklist (all done from the Cloudflare dashboard)
setup:
    #!/usr/bin/env bash
    cat <<'EOF'
    BukTrakr one-time setup (no local tooling needed)
    =================================================

    A. Google Cloud (console.cloud.google.com) — once for the whole app
       1. Create a project (e.g. "buktrakr").
       2. APIs & Services -> Library: enable "Google Drive API" and "Google Docs API".
       3. OAuth consent screen: External, app name "BukTrakr", your email;
          add scope https://www.googleapis.com/auth/drive.file
       4. Publish the consent screen to PRODUCTION (no Google review needed
          for drive.file; avoids 7-day token expiry of Testing mode).
       5. Credentials -> Create OAuth client ID -> Web application.
          Authorized redirect URI: https://YOUR-DOMAIN/auth/callback
          Note the client ID + secret.

    B. Cloudflare dashboard (dash.cloudflare.com)
       1. Storage & Databases -> KV -> Create namespace ("buktrakr").
          Copy the namespace ID into wrangler.jsonc (kv_namespaces[0].id) —
          edit the file on GitHub directly and commit to main.
       2. Workers & Pages -> Create -> Workers -> Import a repository ->
          pick this repo, branch main. Defaults are fine. Every push to
          main now auto-deploys.
       3. Worker -> Settings -> Variables and Secrets:
            Secret GOOGLE_CLIENT_ID      (from A5)
            Secret GOOGLE_CLIENT_SECRET  (from A5)
            Text   APP_URL               https://YOUR-DOMAIN (no trailing /)
            Text   ACCESS_TEAM_DOMAIN    (filled in C)
            Text   ACCESS_AUD            (filled in C)
       4. Worker -> Settings -> Domains & Routes -> Add -> Custom domain ->
          e.g. books.yourdomain.com (DNS + cert created automatically).

    C. Cloudflare Zero Trust (one.dash.cloudflare.com)
       1. Access -> Applications -> Add an application -> Self-hosted.
          Application domain = your hostname; session duration e.g. 1 week.
       2. Add an Allow policy: Include -> Emails (or email domain) for
          everyone who may use the app. One-Time PIN login works out of the
          box; add Google SSO as an identity provider if you prefer.
          Do NOT add a bypass for /auth/callback — it isn't needed.
       3. Back in the Worker's Variables and Secrets, set the real values:
          ACCESS_AUD = the Access app's AUD tag (app -> Overview);
          ACCESS_TEAM_DOMAIN = yourteam.cloudflareaccess.com
          (Zero Trust -> Settings). Saving redeploys immediately.

    Then visit your hostname, pass the Access login, click
    "Connect Google account", and log your first book.
    EOF
