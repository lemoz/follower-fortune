# FollowerFortune

Estimate the combined net worth of a Twitter/X account's **followers** — the people following them, not who they follow.

Three modes:

- **Toy** — deterministic synthetic estimates seeded from the handle. No real data.
- **🛰️ Live** — pulls the account's real followers via [twitterapi.io](https://twitterapi.io) and models wealth from public follower counts.
- **🔬 Researched** — pre-built dossiers where AI research agents identified individual followers from public sources and estimated net worth ranges, with an adversarial verification pass on every entry.

## Run locally

```sh
cp .env.example .env   # paste your twitterapi.io key
node server.mjs        # http://localhost:4173
```

Zero dependencies; needs Node 18+. Without a key, the toy and researched modes still work.

## Deploy

Pushes to `main` auto-deploy to Fly.io via GitHub Actions (`.github/workflows/deploy.yml`).
The API key lives in a Fly secret (`flyctl secrets set TWITTERAPI_KEY=...`), never in the repo.

The server guards the key's credits: per-IP rate limiting, a global daily lookup cap, and a 24h response cache (`server.mjs`).

## Disclaimer

All numbers are speculative guesses for entertainment and research. Nobody's actual net worth is known here. Researched dossiers are AI-compiled from public sources with wide error bars — opinions, not facts, and not financial advice. Listed and want out? Ping [@cdossman](https://x.com/cdossman) for removal.
