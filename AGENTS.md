# NetWorkNetWorth (NWNW) — agent onboarding

You're picking up an existing, **live, public** web project. Read this fully before touching anything, then verify claims against the code — this doc can drift.

## What it is
A website that estimates the **combined net worth of a Twitter/X account's followers** ("how rich is your network"), plus per-person net-worth research. It's for **entertainment and research** — every figure is a labeled speculative estimate, never presented as fact.

## Where it lives
- **Local repo:** `/Users/cdossman/Downloads/follower-fortune/` — note the folder is named `follower-fortune` for historical reasons; the project/app is **networknetworth** (it was renamed).
- **GitHub:** `https://github.com/lemoz/networknetworth` — **push to `main` auto-deploys** via GitHub Actions → Fly.io (`flyctl deploy`). So a broken push ships to prod. Don't push untested code.
- **Live:** `https://networknetworth.fly.dev` (Fly.io app `networknetworth`, region sjc).
- **Persistent data:** a Fly volume mounted at `/data` holds the lookup cache, dynamically-built boards (`/data/boards/*.json`), durable spend counters (`/data/counters.json`), and a search log (`/data/lookups.jsonl`). Locally this is `./.data` (gitignored).

## Architecture (zero-framework, intentionally)
- **`server.mjs`** — the whole backend. A plain Node `http` server (needs one npm dep, `@resvg/resvg-js`, for share cards). Serves the SPA, proxies the paid APIs (keeps keys server-side), builds on-demand boards, enforces spend caps.
- **`index.html`** — the entire frontend (single file, vanilla JS, no build step). Search box → renders a "board."
- **`glm.mjs`** — GLM / Z.ai client (a research/fallback LLM) + a provider-agnostic `searchWeb()`.
- **`gemini.mjs`** — Google Gemini client using the built-in **Google Search grounding** tool; this is the preferred owner-research backend and returns real source citations.
- **`og.mjs`** — renders per-board Open Graph share cards (SVG → PNG). Fonts are bundled in `fonts/` (system fonts fail on the container).
- **`research/*.json`** — 27 **curated boards** (pre-researched, committed). `index.json`, `model.json` (the extrapolation model), `people.json` (richest-people leaderboard) are derived.
- **`tools/*.mjs`** — offline research pipeline (pool sweeps, board minting, batch runners). Not in the request path.

## How research actually works (important mental model)
1. **Curated boards** (the 27 in `research/`) load instantly — pre-built, deep rosters.
2. **Unknown account** → server builds a board **live**: samples the account's real followers from twitterapi, **sweeps the pool of ~807 already-researched wealthy people** to find which of them follow this account (`check_follow_relationship`, direction = *source follows target*), and researches the account owner's own net worth via Gemini (grounded) or GLM (fallback). Assembles it, caches to `/data/boards`, shows it. ~1-3 min ("building this board…" screen). **Every unknown lookup becomes a permanent board — the site deepens as it's used.**
3. **Can't build** (too little pool overlap, out of credits) → honest "in the research queue" message. **Never** a fabricated board.

## External APIs & keys (all metered — real money per call)
Keys live in gitignored `.env` (local) and as **Fly secrets** (prod). Never commit values, never print them, never put them in URLs.
- `TWITTERAPI_KEY` — twitterapi.io, follower data + relationship sweeps. **The main cost driver.**
- `GLM_API_KEY` — Z.ai (GLM), fallback research LLM.
- `GEMINI_API_KEY` — Google Gemini, grounded owner research (model `gemini-flash-latest`).
- `GOOGLE_SEARCH_KEY` / `GOOGLE_CSE_ID` — a Google Custom Search attempt that never activated; effectively dead, safe to ignore/remove.

## Running, deploying, verifying
- **Local:** `node server.mjs` (loads `.env`). Or use the launch config for a preview server.
- **Verify before shipping:** run the change, hit the local server, check console/network, screenshot visual changes. There's a `/code-review` habit here — this project got a 34-agent pre-launch review; keep that bar.
- **Deploy:** commit + `git push` to `main`. CI runs `flyctl deploy`. Watch it: `gh run watch <id> --repo lemoz/networknetworth`.
- **flyctl gotcha:** the CLI sometimes can't read its own token. Workaround: `export FLY_API_TOKEN=$(grep '^access_token:' ~/.fly/config.yml | awk '{print $2}')` before flyctl commands. Fly secrets: `flyctl secrets set KEY=val -a networknetworth`.

## HARD RULES (do not violate)
1. **No fake data, ever.** No invented/placeholder numbers, no misleading errors (e.g. never tell a user a real account "doesn't exist" when the real cause is out-of-credits). If you can't research something, say so.
2. **Everything is a labeled estimate.** Dollar figures must read as speculative guesses inline (not just a footer) — "Estimated net worth (a guess, not a fact)", "≈ estimate", "Est." headers. Don't surface judgmental verdicts ("overstated") on named people.
3. **The owner's private financial figures must never be published.** The owner (@cdossman) has a deliberately wide **$2–10M "estimate"** entry he approved; his actual private numbers must never appear anywhere.
4. **No doxxing.** Don't publish a person's home location alongside their wealth (location is a private LLM hint only, never displayed).
5. **Cost discipline.** Untrusted public traffic must not be able to drain the paid APIs. Spend caps are durable (on `/data`) and enforced at admission; don't weaken them. Gemini grounding needs a **prose-first prompt** — a JSON-only prompt returns zero citations (learned the hard way).

## Current state & likely next work
- **Status:** soft-launched and live. Pre-launch review's 8 blockers are fixed (durable cost caps, doxxing removed, estimate-labeling everywhere, SSRF removed, honesty bugs, queue limits). Gemini grounding is live and returns real citations.
- **Owner (Chris) still owes:** hard prepaid spend caps on the twitterapi.io + Z.ai billing dashboards (the ultimate money backstop — app caps are the first line, not the floor).
- **Open/likely tasks:** (a) a day-one **observability** page (watch builds/spend/errors — today only `/data/lookups.jsonl`); (b) decide the "owner's own net worth" line — keep-when-researched vs remove-everywhere for uniformity; (c) prune dead code (`runReal`/`runResearch`/`syntheticD` in index.html are unreachable toy-model leftovers); (d) more curated boards / research tranches; (e) a real takedown endpoint (currently footer "ping @cdossman"); (f) Gemini grounding-redirect source URLs expire ~30 days — consider resolving to real domains.

## Gotchas learned the hard way
- Repo dir name ≠ app name (see above).
- `gemini-flash-latest`, not a pinned version — pinned Gemini models get deprecated and 404.
- Gemini citations attach to **prose**, not JSON — prompt must ask for a grounded sentence *then* JSON.
- twitterapi returns **HTTP 402** when out of credits — treat as "temporarily unavailable," never "not found."
- The sweep spends ~800 calls per board; there's a daily build cap. Don't remove it.
- If you use `tools/codex_runner.mjs`: `codex exec` hangs forever on an open piped stdin — the runner does `child.stdin.end()`; keep it.

When in doubt: prefer the honest, cheaper, more-conservative option, and verify against the live code before trusting this doc.
