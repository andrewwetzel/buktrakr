# BukTrakr — common commands. Run `just` to list them.
# One-time Cloudflare/Google setup: run `just setup` (full detail in README.md).

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

# Deploy the Worker to Cloudflare
deploy:
    npx wrangler deploy

# Tail live production logs
logs:
    npx wrangler tail

# Create the KV namespace, then paste the printed id into wrangler.jsonc
kv-create:
    npx wrangler kv namespace create KV

# Set the Google OAuth secrets on the deployed Worker (prompts for each value)
secrets:
    npx wrangler secret put GOOGLE_CLIENT_ID
    npx wrangler secret put GOOGLE_CLIENT_SECRET

# Show the stored record for a user, e.g. `just kv-user you@example.com`
kv-user email:
    npx wrangler kv key get "user:{{email}}" --binding KV --remote

# Print the one-time Cloudflare + Google setup checklist
setup:
    #!/usr/bin/env bash
    cat <<'EOF'
    BukTrakr one-time setup
    =======================

    A. Google Cloud (console.cloud.google.com) — once for the whole app
       1. Create a project (e.g. "buktrakr").
       2. APIs & Services -> Library: enable "Google Drive API" and "Google Docs API".
       3. OAuth consent screen: External, app name "BukTrakr", your email;
          add scope https://www.googleapis.com/auth/drive.file
       4. Publish the consent screen to PRODUCTION (no Google review needed for
          drive.file; avoids 7-day token expiry of Testing mode).
       5. Credentials -> Create OAuth client ID -> Web application.
          Authorized redirect URIs:
            https://YOUR-DOMAIN/auth/callback
            http://localhost:8787/auth/callback
          Note the client ID + secret.

    B. Cloudflare
       1. Edit wrangler.jsonc: set your hostname in "routes" and "APP_URL"
          (e.g. books.yourdomain.com — the zone must be in your account).
       2. just kv-create        # paste the printed id into wrangler.jsonc
       3. just secrets          # paste the Google client ID + secret
       4. just deploy           # custom_domain:true auto-creates DNS + cert

    C. Cloudflare Zero Trust (one.dash.cloudflare.com)
       1. Access -> Applications -> Add an application -> Self-hosted.
          Application domain = your hostname; session duration e.g. 1 week.
       2. Add an Allow policy: Include -> Emails (or email domain) for
          everyone who may use the app. One-Time PIN login works out of the
          box; add Google SSO as an identity provider if you prefer.
          Do NOT add a bypass for /auth/callback — it isn't needed.
       3. Copy the app's AUD tag (app -> Overview) into ACCESS_AUD in
          wrangler.jsonc, and set ACCESS_TEAM_DOMAIN to your team domain
          (yourteam.cloudflareaccess.com, under Zero Trust -> Settings).
       4. just deploy           # redeploy with the Access vars filled in

    Then visit your hostname, pass the Access login, click
    "Connect Google account", and log your first book.
    EOF
