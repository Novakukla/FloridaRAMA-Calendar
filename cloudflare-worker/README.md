# FareHarbor → FloridaRAMA Calendar (Cloudflare Worker)

This Worker receives FareHarbor webhooks and triggers the GitHub Action that updates `FloridaRAMA-Calendar/events.json`.

## 1) Install Wrangler

From repo root:

```bash
npm install -g wrangler
```

Login:

```bash
wrangler login
```

## 2) Configure secrets

From `calendar/cloudflare-worker/`:

```bash
wrangler secret put GITHUB_TOKEN
wrangler secret put WEBHOOK_TOKEN
# optional, only if FareHarbor supports HMAC signatures
wrangler secret put WEBHOOK_HMAC_SECRET
```

### GitHub token permissions

Use a **fine-grained PAT** scoped to this repo with:

- Actions: Read/Write (to dispatch workflows)
- Contents: Read (dispatch doesn’t need write; the workflow itself uses `GITHUB_TOKEN`)

## 3) Deploy

```bash
wrangler deploy
```

It will print a URL like:

- `https://floridarama-fareharbor-webhook.<your-subdomain>.workers.dev`

## 4) Give FareHarbor Support these details

Webhook URL:

- `https://...workers.dev/fareharbor/webhook`

Auth header (recommended):

- `Authorization: Bearer <WEBHOOK_TOKEN>`

Health check:

- `https://...workers.dev/health`

## 5) Test it

```bash
curl -i -X POST "https://.../fareharbor/webhook" \
  -H "Authorization: Bearer <WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"test":true}'
```

You should get `202 accepted`, and a workflow run should appear in GitHub Actions.
