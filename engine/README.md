# pulse2-engine (Pulse Board 2 server engine, paper/picks only, never places orders)
Cloudflare Worker (free tier) + D1 `pulse2-engine-db` (table `kv`). Cron `* * * * *` (UTC, every minute, 24/7).
`build.py` bundles shim + the site's own indicators/news/badges/callers modules + glue.js into dist/worker.js (same logic as the site).
Endpoints (GET only, CORS locked to https://rydawg2026.github.io): /state /history /health.
Test locally: `node test_local.mjs 2` (real feeds, fake D1) · `SCORE=1 node test_local.mjs` (settlement, idempotency, lease).
Deploy: create D1, upload dist/worker.js as module worker with D1 binding `DB`, cron schedule, workers.dev subdomain.
Does not touch kalshi-relay / pulse-ask-ai (the relay is only a read-only fallback for Kalshi GETs). No secrets are used or stored.
