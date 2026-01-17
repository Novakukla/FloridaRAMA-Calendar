# FloridaRAMA Calendar

Update `events.json` (run from repo root):

`node scripts/sync_fareharbor_events.mjs --browser --write --events-file "events.json"`

One-time setup (new computer):

`npm install`

`npx playwright install chromium`