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

# Show the stored record for a user's Google sub id, e.g. `just kv-user 1234567890`
kv-user sub:
    npx wrangler kv key get "user:{{sub}}" --binding KV --remote

# Print the one-time setup checklist
setup:
    #!/usr/bin/env bash
    cat <<'EOF'
    BukTrakr one-time setup
    =======================
    Fastest path: click the "Deploy to Cloudflare" button in README.md —
    it clones the repo, provisions the KV namespace, and sets up deploys
    from main. Then do A5 and B2 below.

    A. Google Cloud (console.cloud.google.com)
       1. Create a project (e.g. "buktrakr").
       2. APIs & Services -> Library: enable "Google Drive API" and
          "Google Docs API".
       3. OAuth consent screen: External; scopes openid, userinfo.email,
          and https://www.googleapis.com/auth/drive.file
       4. Publish the consent screen to PRODUCTION (all scopes are
          non-sensitive — no Google review needed; avoids Testing mode's
          7-day refresh-token expiry).
       5. Credentials -> Create OAuth client ID -> Web application.
          Authorized redirect URI: https://YOUR-HOSTNAME/auth/callback
          (workers.dev host or custom domain; optionally also
          http://localhost:8787/auth/callback for local dev).
          Note the client ID + secret.

    B. Cloudflare dashboard (dash.cloudflare.com)
       1. Skip if you used the deploy button. Otherwise: Storage &
          Databases -> KV -> Create namespace; paste its ID into
          wrangler.jsonc (kv_namespaces[0].id); then Workers & Pages ->
          Create -> Workers -> Import a repository -> this repo, branch
          main. Every push to main now auto-deploys.
       2. Worker -> Settings -> Variables and Secrets — add three SECRETS:
            GOOGLE_CLIENT_ID      (from A5)
            GOOGLE_CLIENT_SECRET  (from A5)
            SESSION_SECRET        (any long random string,
                                   e.g. `openssl rand -base64 32`)
       3. Optional: Settings -> Domains & Routes -> Add -> Custom domain.
          Add that hostname's /auth/callback to the Google client too.

    Then visit the app, sign in with Google, and log your first book.
    EOF
