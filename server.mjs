// NetWorkNetWorth (NWNW) live server — zero dependencies (Node 18+ for global fetch).
// Serves the static app AND proxies follower lookups to twitterapi.io so the
// API key stays server-side and never ships to the browser.
//
//   TWITTERAPI_KEY=...  node server.mjs       (or put the key in ./.env)
//
import { createServer } from 'node:http';
import { readFile, readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// durable storage: Fly volume at /data in prod, ./.data locally
const DATA_DIR = process.env.NWNW_DATA_DIR || (existsSync('/data') ? '/data' : join(__dirname, '.data'));
const CACHE_DIR = join(DATA_DIR, 'cache');
try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
const LOG_FILE = join(DATA_DIR, 'lookups.jsonl');
function logLookup(rec) {
  try { appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n'); } catch {}
}

// --- tiny .env loader (so the key can live in ./.env, never in the code) ---
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

const KEY = process.env.TWITTERAPI_KEY || '';
const PORT = process.env.PORT || 4173;
const API = 'https://api.twitterapi.io';
const ORIGIN = (process.env.PUBLIC_ORIGIN || 'https://networknetworth.fly.dev').replace(/\/$/, '');
const RESEARCH_DISABLED = process.env.NWNW_DISABLE_RESEARCH === '1';
const GA_MEASUREMENT_ID = /^G-[A-Z0-9]+$/i.test(process.env.GA_MEASUREMENT_ID || '') ? process.env.GA_MEASUREMENT_ID.toUpperCase() : '';
const GOOGLE_SITE_VERIFICATION = process.env.GOOGLE_SITE_VERIFICATION || '';
const HARD_MAX = 2000; // safety cap on followers fetched per lookup (cost guard)

// --- public-deploy abuse guards (in-memory; reset on restart) ---------------
// Every uncached lookup spends twitterapi.io credits, so cap per-IP and per-day.
const IP_LIMIT = 5;                 // uncached lookups per IP per window
const IP_WINDOW_MS = 15 * 60_000;
const DAILY_CAP = 150;              // uncached lookups per UTC day, all users combined
const CACHE_TTL_MS = 24 * 3600_000;

const BUILD_DAILY_CAP = 25;   // max on-demand builds per UTC day (each sweeps the pool)
const MAX_QUEUED_BUILDS = 3;  // reject new builds past this many waiting (DoS + cost guard)

const ipHits = new Map();  // ip -> [timestamps]
const cache = new Map();   // "handle:cap" -> { ts, payload }

// Durable spend counters: persisted to the Fly volume so scale-to-zero cold
// starts and redeploys do NOT reset the daily budgets (the review's #1 crit).
const COUNTERS_FILE = join(DATA_DIR, 'counters.json');
const utcDay = () => new Date().toISOString().slice(0, 10);
let counters = { day: utcDay(), lookups: 0, builds: 0 };
try { const c = JSON.parse(readFileSync(COUNTERS_FILE, 'utf8')); if (c && c.day) counters = { day: c.day, lookups: c.lookups || 0, builds: c.builds || 0 }; } catch {}
function persistCounters() { try { writeFileSync(COUNTERS_FILE, JSON.stringify(counters)); } catch {} }
function rollDay() { const t = utcDay(); if (counters.day !== t) { counters = { day: t, lookups: 0, builds: 0 }; persistCounters(); } }
function dailyAllowed() { rollDay(); return counters.lookups < DAILY_CAP; }
function countLookup() { rollDay(); counters.lookups++; persistCounters(); }
function buildAllowed() { rollDay(); return counters.builds < BUILD_DAILY_CAP; }
// atomically reserve a build slot at ADMISSION time (before the expensive work),
// closing the race where a burst all passes the check before any build runs.
function reserveBuild() { rollDay(); if (counters.builds >= BUILD_DAILY_CAP) return false; counters.builds++; persistCounters(); return true; }
function refundBuild() { if (counters.builds > 0) { counters.builds--; persistCounters(); } }

function clientIp(req) {
  // Trust ONLY fly-client-ip (set by Fly's proxy, not client-spoofable).
  // x-forwarded-for is attacker-controlled and must NOT gate rate limits.
  const fly = req.headers['fly-client-ip'];
  return (typeof fly === 'string' && fly.trim()) || req.socket.remoteAddress || 'unknown';
}
function ipAllowed(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_LIMIT) { ipHits.set(ip, hits); return false; }
  hits.push(now);
  if (ipHits.size > 10_000) ipHits.clear(); // memory backstop
  ipHits.set(ip, hits);
  return true;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.txt': 'text/plain', '.xml': 'application/xml' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function sendNoIndex(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
  res.end(body);
}

function redirect(res, location, code = 308) {
  res.writeHead(code, { location, 'cache-control': 'public, max-age=3600' });
  res.end();
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: 'method_not_allowed' }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free/unsubscribed twitterapi.io accounts are limited to ~0.2 QPS (1 req / 5s),
// so back off and retry on 429 instead of failing.
async function tw(path, params, retries = 3) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { 'X-API-Key': KEY } });
    if (r.status === 429 && attempt < retries) { await sleep(5500); continue; }
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { status: 'error', message: 'non-JSON from upstream', raw: text.slice(0, 200) }; }
    return { httpStatus: r.status, body };
  }
}

// set when twitterapi.io reports credit exhaustion, so we stop spawning doomed
// builds/lookups and show an honest "queued" message instead of a false error.
let twitterCreditsOutUntil = 0;
function creditsExhausted(body) { return !!(body && body.message && /credit/i.test(body.message)); }

async function lookup(handle, max) {
  // 1) profile (for real display name + true total follower count)
  const info = await tw('/twitter/user/info', { userName: handle });
  // HTTP 402 (or a "credits" message) = out of credits, NOT a missing account.
  if (info.httpStatus === 402 || creditsExhausted(info.body)) {
    twitterCreditsOutUntil = Date.now() + 10 * 60_000;
    return { ok: false, error: 'no_credits', message: 'Live data is temporarily unavailable (upstream credits).' };
  }
  if (info.httpStatus === 401 || info.httpStatus === 403)
    return { ok: false, error: 'bad_key', message: 'twitterapi.io rejected the API key (HTTP ' + info.httpStatus + ').' };
  if (info.httpStatus === 429)
    return { ok: false, error: 'rate_limited', message: 'Rate limited by twitterapi.io.' };
  // transient upstream errors (5xx / non-JSON) must NOT be mistaken for a
  // missing account — that would falsely tell the user the account doesn't exist.
  if (info.httpStatus >= 500)
    return { ok: false, error: 'upstream', message: 'twitterapi.io upstream error (HTTP ' + info.httpStatus + ').' };
  const data = info.body && info.body.data;
  if (!data || (info.body.status && info.body.status !== 'success'))
    return { ok: false, error: 'not_found', message: ('twitterapi.io could not load @' + handle + '. ' + ((info.body && (info.body.msg || info.body.message)) || '')).trim() };

  const profile = {
    userName: data.userName || handle,
    name: data.name || ('@' + handle),
    followers: data.followers || 0,
    isBlueVerified: !!data.isBlueVerified,
    description: data.description || '',
    // real self-reported fields used to GROUND owner net-worth research
    location: data.location || '',
    link: (data.url || (data.entities && data.entities.url && data.entities.url.urls && data.entities.url.urls[0] && data.entities.url.urls[0].expanded_url) || ''),
  };

  // 2) followers (cursor-paginated, 100/page — pageSize 200 is rejected upstream)
  const cap = Math.min(Math.max(parseInt(max, 10) || 200, 20), HARD_MAX);
  const out = [];
  let cursor = '';
  let diag = null;
  for (let guard = 0; out.length < cap && guard < 40; guard++) {
    const page = await tw('/twitter/user/followers', { userName: handle, cursor, pageSize: 100 });
    if (guard === 0) diag = { httpStatus: page.httpStatus, status: page.body && page.body.status, code: page.body && page.body.code, msg: page.body && page.body.msg, flen: (page.body && Array.isArray(page.body.followers)) ? page.body.followers.length : 'NA', keys: page.body ? Object.keys(page.body) : null };
    // out of credits mid-pagination: do NOT return a truncated/empty sample as
    // success (that caches a real account as ~$0). Fail loudly + trip the breaker.
    if (page.httpStatus === 402 || creditsExhausted(page.body)) {
      twitterCreditsOutUntil = Date.now() + 10 * 60_000;
      return { ok: false, error: 'no_credits', message: 'Live data is temporarily unavailable (upstream credits).' };
    }
    if (page.httpStatus === 429) break;            // return whatever we have
    const arr = page.body && page.body.followers;
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const f of arr) out.push({
      userName: f.userName || f.screen_name,
      name: f.name || ('@' + (f.userName || f.screen_name)),
      followers: f.followers_count || f.followers || 0,
      isBlueVerified: !!(f.isBlueVerified || f.verified),
      description: (f.description || '').slice(0, 140),
    });
    cursor = page.body.next_cursor || '';
    if (!page.body.has_next_page || !cursor) break;
  }

  // a real account whose profile reports followers but whose sample came back
  // empty means the fetch failed (throttle/transient) — never publish/cache that
  // as a $0 board. Only accept an empty sample for a genuinely 0-follower account.
  if (out.length === 0 && (profile.followers || 0) > 0)
    return { ok: false, error: 'upstream', message: 'Follower sample was empty for an account that has followers (transient upstream issue).' };

  return { ok: true, profile, totalFollowers: profile.followers, sampleSize: Math.min(out.length, cap), followers: out.slice(0, cap), _diag: out.length ? undefined : diag };
}

// --- on-demand board building (GLM 5.2 research agents) ----------------------
// A person's name is clicked -> if no board exists we build one for real:
// live follower sample + GLM research of the owner and their biggest followers.
// No fake data is ever shown; the client gets a "populating" status + the
// average historical build time until the real board is ready.
const BOARDS_DIR = join(DATA_DIR, 'boards');
const JOBS_STATS = join(DATA_DIR, 'build_stats.json');
try { mkdirSync(BOARDS_DIR, { recursive: true }); } catch {}
const MODEL_PATH = join(__dirname, 'research', 'model.json');
const jobs = new Map(); // handle -> {status, startedAt, finishedAt, error}
let buildChain = Promise.resolve(); // one build at a time (credit + spend guard)
const SWEEP_CONC = 6;          // parallel relationship checks during a build
const MIN_BOARD_MEMBERS = 8;   // refuse to publish a board thinner than this
// (BUILD_DAILY_CAP, buildAllowed(), reserveBuild() are the durable versions defined above.)

// the pool of already-researched wealthy people (from curated boards), each with
// verified worth. Cached for the process lifetime (rebuilt on redeploy/restart).
let POOL = null;
function loadPool() {
  if (POOL) return POOL;
  const map = new Map();
  try {
    for (const f of readdirSync(join(__dirname, 'research'))) {
      if (!f.endsWith('.json') || f === 'index.json' || f === 'model.json' || f === 'people.json') continue;
      const d = JSON.parse(readFileSync(join(__dirname, 'research', f), 'utf8'));
      for (const p of d.people || []) {
        if (!p.identified) continue;
        const k = p.handle.toLowerCase();
        const prev = map.get(k);
        if (!prev || ((p.low + p.high) / 2) > ((prev.low + prev.high) / 2)) map.set(k, p);
      }
    }
  } catch {}
  POOL = [...map.values()];
  return POOL;
}

// concurrency-limited follow sweep: onHit(person) for each pool person who
// follows `target`. Uses tw() so 429s back off. ABORTS the whole sweep on
// credit exhaustion (402) — otherwise the remaining ~800 checks fire doomed and
// we'd assemble a hollow, misleading board with the wealthy followers missing.
async function sweepPool(target, pool, onHit) {
  const queue = pool.slice();
  let aborted = false;
  async function worker() {
    while (queue.length && !aborted) {
      const p = queue.shift();
      const r = await tw('/twitter/user/check_follow_relationship', { source_user_name: p.handle, target_user_name: target }, 2).catch(() => null);
      if (r && (r.httpStatus === 402 || creditsExhausted(r.body))) { aborted = true; break; }
      if (r && r.body && r.body.data && r.body.data.following) onHit(p);
    }
  }
  await Promise.all(Array.from({ length: SWEEP_CONC }, worker));
  if (aborted) { twitterCreditsOutUntil = Date.now() + 10 * 60_000; throw new Error('sample_failed:no_credits'); }
}

function buildStats() {
  try { return JSON.parse(readFileSync(JOBS_STATS, 'utf8')); } catch { return { count: 0, totalMs: 0 }; }
}
function recordBuild(ms) {
  const s = buildStats(); s.count++; s.totalMs += ms;
  try { writeFileSync(JOBS_STATS, JSON.stringify(s)); } catch {}
}
function avgBuildMs() {
  const s = buildStats();
  return s.count ? Math.round(s.totalMs / s.count) : null;
}
function hasStaticBoard(h) { return existsSync(join(__dirname, 'research', h + '.json')); }
function hasDynamicBoard(h) { return existsSync(join(BOARDS_DIR, h + '.json')); }

function boardPath(handle) {
  if (hasStaticBoard(handle)) return join(__dirname, 'research', handle + '.json');
  if (hasDynamicBoard(handle)) return join(BOARDS_DIR, handle + '.json');
  return null;
}

function readBoard(handle) {
  const file = boardPath(handle);
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// Public board payloads deliberately omit free-form research prose. Those fields
// can contain a self-reported location or a judgmental internal verdict, neither
// of which belongs beside a named person's speculative wealth range.
function publicPerson(person) {
  return {
    handle: person.handle,
    name: person.name,
    followers: person.followers || 0,
    identified: person.identified !== false,
    confidence: person.confidence || 'low',
    estimateLabel: 'Speculative estimate, not a verified fact',
    low: Math.round(person.low || 0),
    high: Math.round(person.high || 0),
    source: /^https?:\/\//i.test(person.source || '') ? person.source : undefined,
    sources: Array.isArray(person.sources) ? person.sources.filter((u) => /^https?:\/\//i.test(u)).slice(0, 5) : [],
  };
}

function publicOwner(owner) {
  if (!owner || !(owner.low > 0 || owner.high > 0)) return null;
  return {
    name: owner.name || '',
    confidence: owner.confidence || 'low',
    estimateLabel: 'Speculative estimate, not a verified fact',
    low: Math.round(owner.low || 0),
    high: Math.round(owner.high || 0),
    sources: Array.isArray(owner.sources) ? owner.sources.filter((u) => /^https?:\/\//i.test(u)).slice(0, 5) : [],
    engine: owner.engine || undefined,
  };
}

function publicEstimate(estimate) {
  if (!estimate || typeof estimate !== 'object') return undefined;
  return {
    total: Number(estimate.total) || 0,
    low: Number(estimate.low) || 0,
    high: Number(estimate.high) || 0,
    floor: Number(estimate.floor) || 0,
    estimateLabel: 'Speculative estimate, not a verified fact',
  };
}

function publicBoardData(data) {
  if (!data || !data.meta) return null;
  const source = data.meta;
  // Keep this an explicit allowlist. Internal dossiers and future pipeline
  // fields must never become public merely because they were added upstream.
  const meta = {
    account: source.account || '',
    name: source.name || '',
    totalFollowers: Number(source.totalFollowers) || 0,
    researched: Number(source.researched) || 0,
    identified: Number(source.identified) || 0,
    dynamic: !!source.dynamic,
    engine: source.dynamic && source.engine ? String(source.engine).slice(0, 80) : undefined,
    owner: publicOwner(source.owner),
    sampleDist: source.sampleDist ? {
      sampled: Number(source.sampleDist.sampled) || 0,
      b0: Number(source.sampleDist.b0) || 0,
      b1: Number(source.sampleDist.b1) || 0,
      b2: Number(source.sampleDist.b2) || 0,
      b3: Number(source.sampleDist.b3) || 0,
    } : undefined,
    estimate: publicEstimate(source.estimate),
  };
  return { disclaimer: 'Every monetary figure is a speculative estimate for entertainment and research, not a verified fact.', meta, people: (data.people || []).map(publicPerson) };
}

function publicIndexData() {
  try {
    const rows = JSON.parse(readFileSync(join(__dirname, 'research', 'index.json'), 'utf8'));
    return rows.map((row) => ({
      handle: row.handle || '',
      name: row.name || '',
      total: Number(row.total) || 0,
      est: Number(row.est) || 0,
      followers: Number(row.followers) || 0,
      researched: Number(row.researched) || 0,
      identified: Number(row.identified) || 0,
      estimateLabel: 'Speculative estimate, not a verified fact',
      owner: publicOwner(row.owner),
    }));
  } catch { return []; }
}

function publicPeopleData() {
  try {
    const rows = JSON.parse(readFileSync(join(__dirname, 'research', 'people.json'), 'utf8'));
    return rows.map(publicPerson);
  } catch { return []; }
}

// SECURITY: we deliberately do NOT dereference the profile's t.co link. Following
// an attacker-chosen redirect server-side is an SSRF vector (a crafted profile
// could point at internal/metadata endpoints). The raw link is passed to the LLM
// as a text hint only; it is never fetched by the server.
function resolveLink(url) {
  return url && /^https?:\/\//i.test(url) ? url : '';
}

function modelEstimate(meta, floor) {
  try {
    const MODEL = JSON.parse(readFileSync(MODEL_PATH, 'utf8'));
    const { sampled, b0, b1, b2, b3 } = meta.sampleDist; const s = sampled || 1;
    const q = (b1 + b2 + b3) / s;
    const R = { ...MODEL.identRates };
    R.b0 = Math.max(0.002, Math.min(MODEL.identRates.b0, MODEL.identRates.b0 * q / MODEL.qAnchor));
    const remainder = Math.max(0, meta.totalFollowers - meta.researched);
    let est = floor;
    for (const [k, n] of [['b0', b0], ['b1', b1], ['b2', b2], ['b3', b3]])
      est += remainder * (n / s) * R[k] * MODEL.bucketMeans[k];
    return { total: est, low: est / MODEL.errorFactor, high: est * MODEL.errorFactor, floor };
  } catch { return { total: floor, low: floor, high: floor, floor }; }
}

async function buildBoard(handle) {
  const glm = await import('./glm.mjs');
  const t0 = Date.now();
  // the build slot was already reserved at admission (reserveBuild) — no counting here.
  const cacheKey = handle + ':200';
  const hit = cacheRead(cacheKey);
  // the in-build follower sample is itself a paid twitterapi call — gate it on
  // the daily lookup budget too, so builds can't bypass DAILY_CAP.
  if (!hit && !dailyAllowed()) throw new Error('sample_failed:daily_cap');
  let result = hit ? JSON.parse(hit.payload) : await lookup(handle, 200);
  // genuine missing account is terminal; anything else is a transient/retryable
  // failure and must NOT be reported to the user as "doesn't exist".
  if (!result.ok) throw new Error(result.error === 'not_found' ? 'not_found' : 'sample_failed:' + result.error);
  if (!hit) { countLookup(); cacheWrite(cacheKey, JSON.stringify(result)); }

  const sample = result.followers || [];
  const c = { b0: 0, b1: 0, b2: 0, b3: 0 };
  for (const f of sample) { const n = f.followers || 0; if (n < 1e3) c.b0++; else if (n < 1e4) c.b1++; else if (n < 1e5) c.b2++; else c.b3++; }

  // sweep our verified pool -> which known-wealthy people follow this account
  const pool = loadPool().filter((p) => p.handle.toLowerCase() !== handle);
  const members = [];
  await sweepPool(handle, pool, (p) => members.push({
    handle: p.handle, name: p.name, followers: p.followers || 0, identified: true,
    headline: p.headline, verdict: p.verdict, confidence: p.confidence,
    low: p.low, high: p.high, sources: p.sources || [],
  }));

  // GLM: owner net worth (grounded on the real profile + resolved link) + any
  // big NET-NEW sampled followers the sweep missed
  const link = resolveLink(result.profile.link);
  const owner = await glm.researchOwner({ ...result.profile, link }).catch(() => null);
  const known = new Set(members.map((m) => m.handle.toLowerCase()));
  const bigNew = sample.filter((f) => (f.followers || 0) >= 1e5 && !known.has((f.userName || '').toLowerCase())).slice(0, 8);
  const glmPeople = (await Promise.all(bigNew.map((f) => glm.researchPerson(f).catch(() => null)))).filter(Boolean);

  const people = [...members, ...glmPeople].sort((a, b) => ((b.low + b.high) / 2) - ((a.low + a.high) / 2));

  // NEVER publish a thin board — it would show a real-looking page with almost
  // no evidence. Below the floor, report honestly (retryable) instead.
  if (people.length < MIN_BOARD_MEMBERS) throw new Error('insufficient_data');

  const floor = people.reduce((a, p) => a + (p.low + p.high) / 2, 0);
  const meta = {
    account: result.profile.userName, name: result.profile.name,
    totalFollowers: result.totalFollowers,
    researched: people.length, identified: people.length,
    dynamic: true, engine: process.env.GLM_MODEL || 'glm-5', builtAt: new Date().toISOString(),
    note: 'Auto-built on request: researched followers found via the follow-relationship sweep (their worth was already verified on curated boards), plus a GLM agent for the owner. Owner + AI-added people are unverified; curated boards get an adversarial pass, this has not yet.',
    sampleDist: { sampled: sample.length, ...c },
  };
  if (owner) meta.owner = owner;
  // Show ONLY the researched floor (sum of identified members). The model
  // extrapolation is valid only for the large curated samples — on a thin
  // on-demand sweep it would fabricate a huge total from follower count alone.
  meta.estimate = { total: floor, low: floor / 2, high: floor * 1.5, floor };
  writeFileSync(join(BOARDS_DIR, handle + '.json'), JSON.stringify({ meta, people }, null, 1));
  recordBuild(Date.now() - t0);
}

function queuedBuildCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'building' || j.status === 'queued') n++;
  return n;
}
// caller must have already reserved a build slot (reserveBuild) at admission.
function requestBoard(handle) {
  const existing = jobs.get(handle);
  if (existing && (existing.status === 'building' || existing.status === 'queued')) { refundBuild(); return existing; }
  const job = { status: 'queued', startedAt: Date.now() };
  jobs.set(handle, job);
  buildChain = buildChain.then(async () => {
    job.status = 'building';
    job.startedAt = Date.now();
    try {
      await buildBoard(handle);
      job.status = 'done';
    } catch (e) {
      const msg = String((e && e.message) || e);
      job.status = 'failed';
      job.error = msg;
      // failures BEFORE the sweep (missing account, sample/credits) spent
      // little — refund the reserved slot. 'insufficient_data' fires AFTER the
      // sweep already spent ~800 credits, so it keeps the slot.
      if (msg === 'not_found' || /^sample_failed:/.test(msg)) refundBuild();
      // terminal = re-attempting can't help: account truly missing, or we simply
      // don't have enough researched people in its network yet. Everything else
      // (credits, upstream, over-cap) is transient and retried on the next click.
      job.terminal = (msg === 'not_found' || msg === 'insufficient_data');
      logLookup({ handle, buildFailed: msg });
    }
    job.finishedAt = Date.now();
  });
  return job;
}

function boardStatusPayload(handle) {
  if (hasStaticBoard(handle) || hasDynamicBoard(handle)) return { status: 'ready' };
  const job = jobs.get(handle);
  const avgMs = avgBuildMs();
  if (job) {
    if (job.status === 'failed') return { status: 'failed', reason: job.error, avgMs };
    if (job.status === 'done') return { status: 'ready', avgMs };
    return { status: job.status, elapsedMs: Date.now() - job.startedAt, avgMs };
  }
  return { status: 'none', avgMs };
}

// shared lookup cache (mem -> disk); used by /api/lookup AND board builds so a
// build never re-spends credits on an account someone just sampled.
function cachePathFor(cacheKey) { return join(CACHE_DIR, cacheKey.replace(/[^a-z0-9_:-]/gi, '') + '.json'); }
function cacheRead(cacheKey) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { payload: hit.payload, from: 'mem' };
  const diskPath = cachePathFor(cacheKey);
  if (existsSync(diskPath)) {
    try {
      const d = JSON.parse(readFileSync(diskPath, 'utf8'));
      if (Date.now() - d.ts < CACHE_TTL_MS) { cache.set(cacheKey, d); return { payload: d.payload, from: 'disk' }; }
    } catch {}
  }
  return null;
}
function cacheWrite(cacheKey, payload) {
  const entry = { ts: Date.now(), payload };
  cache.set(cacheKey, entry);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  try { writeFileSync(cachePathFor(cacheKey), JSON.stringify(entry)); } catch {}
}

function readyBoards() {
  const boards = new Map();
  const addDir = (dir, dynamic) => {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json') || ['index.json', 'model.json', 'people.json'].includes(file)) continue;
        const handle = file.slice(0, -5).toLowerCase();
        if (!/^[a-z0-9_]{1,15}$/.test(handle) || boards.has(handle)) continue;
        try {
          const fullPath = join(dir, file);
          const data = JSON.parse(readFileSync(fullPath, 'utf8'));
          if (!data.meta || !data.meta.account) continue;
          boards.set(handle, {
            handle,
            name: data.meta.name || '@' + handle,
            dynamic,
            lastmod: new Date(statSync(fullPath).mtimeMs).toISOString().slice(0, 10),
          });
        } catch {}
      }
    } catch {}
  };
  addDir(join(__dirname, 'research'), false);
  addDir(BOARDS_DIR, true);
  return [...boards.values()].sort((a, b) => a.handle.localeCompare(b.handle));
}

function sitemapXML() {
  const appLastmod = new Date(statSync(join(__dirname, 'index.html')).mtimeMs).toISOString().slice(0, 10);
  const urls = [{ loc: ORIGIN + '/', lastmod: appLastmod }, { loc: ORIGIN + '/privacy', lastmod: appLastmod }]
    .concat(readyBoards().map((b) => ({ loc: ORIGIN + '/b/' + b.handle, lastmod: b.lastmod })));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${xmlEsc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n') +
    '\n</urlset>\n';
}

function boardLinksHTML(currentHandle) {
  const links = readyBoards().map((b) => {
    const current = currentHandle === b.handle ? ' aria-current="page"' : '';
    return `<a href="/b/${esc(b.handle)}"${current}>@${esc(b.handle)}</a>`;
  }).join(' ');
  return links ? `<nav class="board-directory" aria-label="Researched boards"><span>Explore researched boards:</span> ${links}</nav>` : '';
}

function xmlEsc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/version') {
    try {
      const { statSync } = await import('node:fs');
      return send(res, 200, JSON.stringify({ v: String(statSync(join(__dirname, 'index.html')).mtimeMs) }));
    } catch { return send(res, 200, JSON.stringify({ v: '0' })); }
  }

  if (u.pathname === '/api/lookup') {
    if (!KEY) return send(res, 200, JSON.stringify({ ok: false, error: 'no_api_key', message: 'No TWITTERAPI_KEY found. Add it to .env and restart.' }));
    const handle = (u.searchParams.get('handle') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15).toLowerCase();
    if (!handle) return send(res, 200, JSON.stringify({ ok: false, error: 'bad_handle', message: 'Missing or invalid handle.' }));

    const cap = Math.min(Math.max(parseInt(u.searchParams.get('max'), 10) || 200, 20), HARD_MAX);
    const cacheKey = handle + ':' + cap;
    const hit = cacheRead(cacheKey);
    if (hit) { logLookup({ handle, cap, cached: hit.from }); return send(res, 200, hit.payload); }

    if (!ipAllowed(clientIp(req)))
      return send(res, 429, JSON.stringify({ ok: false, error: 'rate_limited', message: 'Too many lookups from your address. Try again in a few minutes.' }));
    if (!dailyAllowed())
      return send(res, 429, JSON.stringify({ ok: false, error: 'daily_cap', message: 'Daily lookup budget exhausted. Fresh lookups resume tomorrow (UTC) — cached and researched boards still work.' }));

    try {
      const result = await lookup(handle, cap);
      const payload = JSON.stringify(result);
      if (result.ok) {
        countLookup();
        cacheWrite(cacheKey, payload);
        logLookup({ handle, cap, cached: false, followers: result.totalFollowers, sampled: result.sampleSize });
      } else {
        countLookup(); // a failed lookup still spent a profile call — count it so floods of bad handles can't bypass the cap
        logLookup({ handle, cap, cached: false, error: result.error });
      }
      return send(res, 200, payload);
    }
    catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: 'server', message: String((e && e.message) || e) })); }
  }

  // --- on-demand board building ---
  if (u.pathname === '/api/board_request' || u.pathname === '/api/board_status') {
    const isRequest = u.pathname === '/api/board_request';
    if (isRequest && req.method !== 'POST') return methodNotAllowed(res, 'POST');
    if (!isRequest && req.method !== 'GET') return methodNotAllowed(res, 'GET');
    // A build is a paid, state-changing action. Requiring an explicit POST plus
    // an application header prevents link scanners, prefetchers, and ordinary
    // crawlers from starting research merely by discovering a URL.
    if (isRequest && req.headers['x-nwnw-action'] !== 'build')
      return send(res, 403, JSON.stringify({ status: 'forbidden' }));
    const handle = (u.searchParams.get('handle') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15).toLowerCase();
    if (!handle) return send(res, 200, JSON.stringify({ status: 'bad_handle' }));
    // on an explicit build request, clear a stale transient failure so it retries
    // (terminal failures — missing account / not enough data — stay put).
    if (isRequest) {
      const j = jobs.get(handle);
      if (j && j.status === 'failed' && !j.terminal) jobs.delete(handle);
    }
    const cur = boardStatusPayload(handle);
    if (!isRequest || cur.status !== 'none')
      return send(res, 200, JSON.stringify(cur));
    // new request: only start a build if the whole pipeline can actually run
    const { glmAvailable } = await import('./glm.mjs');
    if (RESEARCH_DISABLED || !KEY || !glmAvailable() || Date.now() < twitterCreditsOutUntil) {
      logLookup({ handle, boardRequest: 'queued_offline' });
      return send(res, 200, JSON.stringify({ status: 'offline', avgMs: avgBuildMs() }));
    }
    if (!ipAllowed(clientIp(req)))
      return send(res, 429, JSON.stringify({ status: 'rate_limited' }));
    // bound how many builds can be waiting at once (each sweeps ~800 paid calls
    // and runs serially) — a spike gets an honest "busy" instead of a cost/DoS
    // pileup. Dedup requests for the same handle don't count.
    if (!(jobs.get(handle) && (jobs.get(handle).status === 'building' || jobs.get(handle).status === 'queued')) && queuedBuildCount() >= MAX_QUEUED_BUILDS) {
      logLookup({ handle, boardRequest: 'queue_full' });
      return send(res, 200, JSON.stringify({ status: 'busy', avgMs: avgBuildMs() }));
    }
    // reserve a build slot ATOMICALLY at admission (closes the race where a
    // burst all passes buildAllowed() before any build increments the counter).
    if (!reserveBuild()) {
      logLookup({ handle, boardRequest: 'over_daily_cap' });
      return send(res, 200, JSON.stringify({ status: 'offline', avgMs: avgBuildMs() }));
    }
    logLookup({ handle, boardRequest: 'build' });
    requestBoard(handle); // consumes (or refunds) the reserved slot
    return send(res, 200, JSON.stringify(boardStatusPayload(handle)));
  }

  if (u.pathname === '/robots.txt') {
    return send(res, 200, `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${ORIGIN}/sitemap.xml\n`, 'text/plain; charset=utf-8');
  }
  if (u.pathname === '/sitemap.xml') return send(res, 200, sitemapXML(), 'application/xml; charset=utf-8');

  // Public research responses are purpose-built and sanitized. Raw committed
  // dossiers and internal tools are never exposed through the static server.
  if (u.pathname === '/research/index.json') return sendNoIndex(res, 200, JSON.stringify(publicIndexData()));
  if (u.pathname === '/research/people.json') return sendNoIndex(res, 200, JSON.stringify(publicPeopleData()));
  if (u.pathname === '/research/model.json') {
    try { return sendNoIndex(res, 200, readFileSync(MODEL_PATH, 'utf8')); } catch { return send(res, 404, 'Not found', 'text/plain'); }
  }
  const rMatch = u.pathname.match(/^\/research\/([A-Za-z0-9_]{1,15})\.json$/);
  if (rMatch) {
    const data = publicBoardData(readBoard(rMatch[1].toLowerCase()));
    return data ? sendNoIndex(res, 200, JSON.stringify(data)) : send(res, 404, 'Not found', 'text/plain');
  }

  // --- Open Graph share cards ---
  const ogMatch = u.pathname.match(/^\/og\/([A-Za-z0-9_]{1,15})\.png$/);
  if (ogMatch) return sendOG(res, ogMatch[1].toLowerCase());

  if (u.pathname === '/privacy') return sendPrivacyHTML(res);

  // board share URL: serve index.html with per-board OG meta injected so
  // crawlers (X, iMessage) unfurl the right card; the SPA reads the path too.
  const bMatch = u.pathname.match(/^\/b\/([A-Za-z0-9_]{1,15})$/);
  if (bMatch) {
    const rawHandle = bMatch[1];
    const handle = rawHandle.toLowerCase();
    if (rawHandle !== handle) return redirect(res, '/b/' + handle);
    const meta = boardMeta(handle);
    return meta ? sendBoardHTML(res, handle, meta) : sendMissingBoardHTML(res, handle);
  }

  if (u.pathname === '/') return sendBoardHTML(res, null, null);
  if (u.pathname === '/index.html') return redirect(res, '/');
  if (u.pathname === '/favicon.ico') return redirect(res, '/favicon.svg');

  // Strict public allowlist: never serve source, dotfiles, raw research, tools,
  // git metadata, or local secrets merely because they exist beside the app.
  const publicFiles = new Map([['/favicon.svg', join(__dirname, 'favicon.svg')]]);
  const file = publicFiles.get(u.pathname);
  if (!file) return send(res, 404, 'Not found', 'text/plain');
  readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[extname(file)] || 'application/octet-stream');
  });
});

// --- OG helpers ---
function boardMeta(handle) {
  const data = readBoard(handle);
  return data && data.meta || null;
}

const CARD_VERSION = 4; // bump when card rendering changes, to invalidate cached PNGs
async function sendOG(res, handle) {
  const m = boardMeta(handle);
  const est = (m && m.estimate) || {};
  const shownTotal = displayEstimate(m);
  // cache key includes the card version AND the current total, so cards
  // auto-refresh when the code changes or the modeled number moves.
  const stamp = CARD_VERSION + '_' + Math.round(shownTotal);
  const cacheFile = join(CACHE_DIR, 'og_' + handle + '_' + stamp + '.png');
  try {
    if (existsSync(cacheFile)) {
      const buf = readFileSync(cacheFile);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return res.end(buf);
    }
  } catch {}
  try {
    const og = await import('./og.mjs');
    let svg;
    if (m) {
      svg = og.cardSVG({ handle: m.account, name: m.name, total: shownTotal, floor: est.floor, identified: m.identified, researched: m.researched, owner: m.owner });
    } else {
      svg = og.defaultCardSVG();
    }
    const png = await og.renderPNG(svg);
    if (png) {
      try { writeFileSync(cacheFile, png); } catch {}
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return res.end(png);
    }
  } catch {}
  // fail-soft: if rendering is entirely unavailable, no image (same as pre-OG;
  // never a broken deploy). Crawlers just show no card.
  send(res, 404, 'no card', 'text/plain');
}

function fmtMoney(n) {
  return n >= 1e12 ? '$' + (n / 1e12).toFixed(2) + 'T'
    : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
      : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M'
        : '$' + Math.round(n / 1e3) + 'K';
}

function displayEstimate(meta) {
  const est = meta && meta.estimate || {};
  const floor = est.floor || 0;
  return est.total > floor * 1.2 ? est.total : (floor || est.total || 0);
}

function sendBoardHTML(res, handle, m) {
  let html;
  try { html = readFileSync(join(__dirname, 'index.html'), 'utf8'); } catch { return send(res, 500, 'error', 'text/plain'); }
  let title, desc, image, summary = '';
  const canonical = ORIGIN + (handle ? '/b/' + handle : '/');
  if (m) {
    const total = displayEstimate(m);
    title = `@${m.account} follower network estimated at ~${fmtMoney(total)} | NWNW`;
    desc = `Estimated follower-network net worth: about ${fmtMoney(total)} across @${m.account}'s researched followers, including ${(m.identified || 0).toLocaleString()} identified people.`;
    image = `${ORIGIN}/og/${m.account}.png`;
    summary = `<section class="server-summary" id="server-summary"><h2>@${esc(m.account)} follower network</h2><p><strong>Estimated follower-network net worth:</strong> approximately ${esc(fmtMoney(total))}.</p><p>${(m.identified || 0).toLocaleString()} people identified through public-source research.</p></section>`;
  } else {
    title = 'Estimate an X follower network’s net worth | NetWorkNetWorth';
    desc = 'Estimate the combined net worth of an X or Twitter account\'s followers using public-source research.';
    image = `${ORIGIN}/og/default.png`;
  }
  const structured = m ? {
    '@context': 'https://schema.org', '@type': 'WebPage', name: title, url: canonical, description: desc,
    isPartOf: { '@type': 'WebSite', name: 'NetWorkNetWorth', alternateName: 'NWNW', url: ORIGIN + '/' },
  } : {
    '@context': 'https://schema.org', '@type': 'WebSite', name: 'NetWorkNetWorth', alternateName: 'NWNW', url: ORIGIN + '/', description: desc,
  };
  const tags = [
    `<meta name="description" content="${esc(desc)}"/>`,
    `<meta name="robots" content="index,follow,max-image-preview:large"/>`,
    `<link rel="canonical" href="${canonical}"/>`,
    GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(GOOGLE_SITE_VERIFICATION)}"/>` : '',
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:site_name" content="NetWorkNetWorth"/>`,
    `<meta property="og:title" content="${esc(title)}"/>`,
    `<meta property="og:description" content="${esc(desc)}"/>`,
    `<meta property="og:image" content="${image}"/>`,
    `<meta property="og:image:width" content="1200"/>`,
    `<meta property="og:image:height" content="630"/>`,
    `<meta property="og:image:alt" content="${esc(title)}"/>`,
    `<meta property="og:url" content="${canonical}"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`,
    `<meta name="twitter:title" content="${esc(title)}"/>`,
    `<meta name="twitter:description" content="${esc(desc)}"/>`,
    `<meta name="twitter:image" content="${image}"/>`,
    `<meta name="twitter:image:alt" content="${esc(title)}"/>`,
    `<script type="application/ld+json">${JSON.stringify(structured).replace(/</g, '\\u003c')}</script>`,
  ].filter(Boolean).join('\n');
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = html.replace('<!--OG-->', tags);
  html = html.replace('<!--ANALYTICS-CONFIG-->', `<script>window.NWNW_ANALYTICS_ID=${JSON.stringify(GA_MEASUREMENT_ID)};</script>`);
  html = html.replace('<!--SERVER-SUMMARY-->', summary);
  html = html.replace('<!--BOARD-LINKS-->', boardLinksHTML(handle));
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(html);
}

function sendMissingBoardHTML(res, handle) {
  const title = `@${handle} board not researched | NetWorkNetWorth`;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="icon" href="/favicon.svg"></head><body style="font-family:system-ui;background:#070912;color:#e8ecf6;padding:40px;max-width:720px;margin:auto"><main><h1>${esc(title)}</h1><p>There is no completed research board for @${esc(handle)}. No estimate or placeholder number is available.</p><p><a href="/" style="color:#ffd24a">Return to NetWorkNetWorth</a> to request research deliberately.</p></main></body></html>`;
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex,nofollow' });
  res.end(body);
}

function sendPrivacyHTML(res) {
  const title = 'Privacy and optional analytics | NetWorkNetWorth';
  const desc = 'How NetWorkNetWorth handles optional analytics and stores an analytics choice.';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${esc(desc)}"><meta name="robots" content="index,follow"><link rel="canonical" href="${ORIGIN}/privacy"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>${esc(title)}</title><style>body{font-family:system-ui;background:#070912;color:#e8ecf6;padding:40px 20px;margin:auto;max-width:760px;line-height:1.65}h1,h2{line-height:1.2}p,li{color:#b8c0d4}a{color:#ffd24a}.card{background:#11162a;border:1px solid #28304a;border-radius:16px;padding:20px}</style></head><body><main><p><a href="/">← NetWorkNetWorth</a></p><h1>Privacy and optional analytics</h1><div class="card"><h2>Analytics is opt-in</h2><p>NetWorkNetWorth does not load Google Analytics unless you choose “Accept analytics.” Declining does not change access to the site or its research boards.</p><h2>What the optional tag measures</h2><p>If accepted, Google Analytics may process page views, interactions, device and browser information, a first-party client identifier, and approximate geographic information. NetWorkNetWorth disables advertising storage, Google signals, ad user data, and ad personalization in its tag configuration.</p><h2>Your choice</h2><p>The choice is stored in your browser's local storage. Use “Analytics choices” in the site footer to change it. Declining after acceptance disables further Analytics collection from this site in that browser session.</p><h2>Research data</h2><p>Public boards contain speculative estimates compiled from public sources. Free-form biographical and location prose is removed from the public payload. To request removal from a board, contact <a href="https://x.com/cdossman">@cdossman</a>.</p></div></main></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' });
  res.end(body);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

server.listen(PORT, () => console.log(`NetWorkNetWorth live on http://localhost:${PORT}  (API key ${KEY ? 'loaded' : 'MISSING — synthetic only'})`));
