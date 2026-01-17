# FloridaRAMA Calendar (Wix embed)

This repo powers the Wix embedded calendar (FullCalendar) by loading a JSON file of events.

**Source of truth:** `events.json`

Wix embeds `init.html` in an iframe. The page then fetches `events.json` from GitHub raw.

## Folder map

- Calendar UI embed page: `init.html`
- Event data: `events.json`
- FareHarbor sync script: `scripts/sync_fareharbor_events.mjs`
- Webhook receiver (Cloudflare Worker): `cloudflare-worker/`
- Automation: `.github/workflows/sync-fareharbor-events.yml`
- Playwright deps live in: `package.json`

## How Wix loads events

`init.html` looks for an optional `events` query param, so you can override the source in Wix by adding a query param to the iframe src:

`?events=https://raw.githubusercontent.com/<OWNER>/<REPO>/main/events.json`

If no query param is provided, `init.html` will try (in order):

1. `?events=...`
2. `events.json` next to `init.html` (same directory)
3. A hardcoded fallback raw URL for this repo:
	 `https://raw.githubusercontent.com/Novakukla/FloridaRAMA-Calendar/main/events.json`

## Local setup (dev machine)

From repo root:

1. Install deps: `npm install`
2. One-time browser install: `npx playwright install chromium`

## Manual update flow

1. Edit `events.json`
2. Commit + push

Wix reads the updated raw JSON.

## Automated update (scheduled)

GitHub Action: `.github/workflows/sync-fareharbor-events.yml`

- Runs daily
- Can be run manually via GitHub → Actions → “Sync FareHarbor Events”
- Runs `node scripts/sync_fareharbor_events.mjs --browser --write --events-file events.json` and commits `events.json`
- By default, the sync **overwrites** `events.json` so it matches the FareHarbor booking flow exactly.
	- If you ever need to preserve manual/non-FareHarbor entries, run the script with `--merge-existing`.

## Automated update (webhook-triggered)

The Cloudflare Worker receives FareHarbor webhooks and triggers the GitHub Action via `workflow_dispatch`.

- Worker code: `cloudflare-worker/src/index.js`
- Deploy instructions: `cloudflare-worker/README.md`

### Required Worker secrets

- `GITHUB_TOKEN` = fine‑grained PAT with Actions: Read/Write on this repo
- `WEBHOOK_TOKEN` = shared secret you give FareHarbor (`Authorization: Bearer ...`)

### Optional Worker secret

- `WEBHOOK_HMAC_SECRET` = used to verify `X-Signature-256` (if FareHarbor supports signatures)

## What to update after moving to a new repo

- Update the fallback raw GitHub URL in `init.html` (unless you always use the `?events=` override).
- In Cloudflare Worker config, set repo vars in `cloudflare-worker/wrangler.toml`:
	- `GITHUB_OWNER`
	- `GITHUB_REPO`
	- `GITHUB_WORKFLOW_FILE` (should stay `sync-fareharbor-events.yml`)
	- `GITHUB_REF` (usually `main`)
- Confirm the GitHub Action still has permissions: `contents: write` so it can commit.

## FareHarbor flow

This repo is currently configured to scrape the booking flow `1438415` by default.
You can override it by setting `FAREHARBOR_FLOW` (locally or in GitHub Actions).