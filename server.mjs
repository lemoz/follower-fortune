// NetWorkNetWorth (NWNW) live server — zero dependencies (Node 18+ for global fetch).
// Serves the static app AND proxies follower lookups to twitterapi.io so the
// API key stays server-side and never ships to the browser.
//
//   TWITTERAPI_KEY=...  node server.mjs       (or put the key in ./.env)
//
import { createServer } from 'node:http';
import { readFile, readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// durable storage: Fly volume at /data in prod, ./.data locally
const DATA_DIR = existsSync('/data') ? '/data' : join(__dirname, '.data');
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
const HARD_MAX = 2000; // safety cap on followers fetched per lookup (cost guard)

// --- public-deploy abuse guards (in-memory; reset on restart) ---------------
// Every uncached lookup spends twitterapi.io credits, so cap per-IP and per-day.
const IP_LIMIT = 5;                 // uncached lookups per IP per window
const IP_WINDOW_MS = 15 * 60_000;
const DAILY_CAP = 150;              // uncached lookups per UTC day, all users combined
const CACHE_TTL_MS = 24 * 3600_000;

const ipHits = new Map();  // ip -> [timestamps]
const cache = new Map();   // "handle:cap" -> { ts, payload }
let dailyCount = 0;
let dailyDay = new Date().toISOString().slice(0, 10);

function clientIp(req) {
  const fwd = req.headers['fly-client-ip'] || req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
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
function dailyAllowed() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyDay) { dailyDay = today; dailyCount = 0; }
  return dailyCount < DAILY_CAP;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
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

async function lookup(handle, max) {
  // 1) profile (for real display name + true total follower count)
  const info = await tw('/twitter/user/info', { userName: handle });
  if (info.httpStatus === 401 || info.httpStatus === 403)
    return { ok: false, error: 'bad_key', message: 'twitterapi.io rejected the API key (HTTP ' + info.httpStatus + ').' };
  if (info.httpStatus === 429)
    return { ok: false, error: 'rate_limited', message: 'Rate limited by twitterapi.io.' };
  const data = info.body && info.body.data;
  if (!data || (info.body.status && info.body.status !== 'success'))
    return { ok: false, error: 'not_found', message: ('twitterapi.io could not load @' + handle + '. ' + ((info.body && (info.body.msg || info.body.message)) || '')).trim() };

  const profile = {
    userName: data.userName || handle,
    name: data.name || ('@' + handle),
    followers: data.followers || 0,
    isBlueVerified: !!data.isBlueVerified,
    description: data.description || '',
  };

  // 2) followers (cursor-paginated, 100/page — pageSize 200 is rejected upstream)
  const cap = Math.min(Math.max(parseInt(max, 10) || 200, 20), HARD_MAX);
  const out = [];
  let cursor = '';
  let diag = null;
  for (let guard = 0; out.length < cap && guard < 40; guard++) {
    const page = await tw('/twitter/user/followers', { userName: handle, cursor, pageSize: 100 });
    if (guard === 0) diag = { httpStatus: page.httpStatus, status: page.body && page.body.status, code: page.body && page.body.code, msg: page.body && page.body.msg, flen: (page.body && Array.isArray(page.body.followers)) ? page.body.followers.length : 'NA', keys: page.body ? Object.keys(page.body) : null };
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
const GLM_TOP_N = 12; // biggest sampled followers researched per board

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
  const cacheKey = handle + ':200';
  const hit = cacheRead(cacheKey);
  let result = hit ? JSON.parse(hit.payload) : await lookup(handle, 200);
  if (!result.ok) throw new Error(result.error === 'not_found' ? 'not_found' : 'sample_failed:' + result.error);
  if (!hit) { dailyCount++; cacheWrite(cacheKey, JSON.stringify(result)); }

  const sample = result.followers || [];
  const c = { b0: 0, b1: 0, b2: 0, b3: 0 };
  for (const f of sample) { const n = f.followers || 0; if (n < 1e3) c.b0++; else if (n < 1e4) c.b1++; else if (n < 1e5) c.b2++; else c.b3++; }

  // GLM research: owner + the biggest sampled followers (isolated failures OK)
  const owner = await glm.researchOwner(result.profile).catch(() => null);
  const top = sample.slice().sort((a, b) => (b.followers || 0) - (a.followers || 0)).slice(0, GLM_TOP_N);
  const people = [];
  for (const f of top) {
    const p = await glm.researchPerson(f).catch(() => null);
    if (p) people.push(p);
  }
  people.sort((a, b) => ((b.low + b.high) / 2) - ((a.low + a.high) / 2));
  const floor = people.reduce((a, p) => a + (p.low + p.high) / 2, 0);

  const meta = {
    account: result.profile.userName, name: result.profile.name,
    totalFollowers: result.totalFollowers,
    researched: top.length, identified: people.length,
    dynamic: true, engine: process.env.GLM_MODEL || 'glm-5.2', builtAt: new Date().toISOString(),
    note: 'Auto-built on request: real follower sample + AI research of the largest sampled followers. Unverified — curated boards get adversarial verification, this one has not yet.',
    sampleDist: { sampled: sample.length, ...c },
  };
  if (owner) meta.owner = owner;
  meta.estimate = modelEstimate(meta, floor);
  writeFileSync(join(BOARDS_DIR, handle + '.json'), JSON.stringify({ meta, people }, null, 1));
  recordBuild(Date.now() - t0);
}

function requestBoard(handle) {
  const existing = jobs.get(handle);
  if (existing && (existing.status === 'building' || existing.status === 'queued')) return existing;
  const job = { status: 'queued', startedAt: Date.now() };
  jobs.set(handle, job);
  buildChain = buildChain.then(async () => {
    job.status = 'building';
    job.startedAt = Date.now();
    try {
      await buildBoard(handle);
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      job.error = String((e && e.message) || e);
      logLookup({ handle, buildFailed: job.error });
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
        dailyCount++;
        cacheWrite(cacheKey, payload);
        logLookup({ handle, cap, cached: false, followers: result.totalFollowers, sampled: result.sampleSize });
      } else {
        logLookup({ handle, cap, cached: false, error: result.error });
      }
      return send(res, 200, payload);
    }
    catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: 'server', message: String((e && e.message) || e) })); }
  }

  // --- on-demand board building ---
  if (u.pathname === '/api/board_request' || u.pathname === '/api/board_status') {
    const handle = (u.searchParams.get('handle') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15).toLowerCase();
    if (!handle) return send(res, 200, JSON.stringify({ status: 'bad_handle' }));
    const cur = boardStatusPayload(handle);
    if (u.pathname === '/api/board_status' || cur.status !== 'none')
      return send(res, 200, JSON.stringify(cur));
    // new request: only start a build if the whole pipeline can actually run
    const { glmAvailable } = await import('./glm.mjs');
    if (!KEY || !glmAvailable()) {
      logLookup({ handle, boardRequest: 'queued_offline' });
      return send(res, 200, JSON.stringify({ status: 'offline', avgMs: avgBuildMs() }));
    }
    if (!ipAllowed(clientIp(req)) || !dailyAllowed())
      return send(res, 429, JSON.stringify({ status: 'rate_limited' }));
    logLookup({ handle, boardRequest: 'build' });
    requestBoard(handle);
    return send(res, 200, JSON.stringify(boardStatusPayload(handle)));
  }

  // dynamic boards: /research/<handle>.json falls through to /data/boards
  const rMatch = u.pathname.match(/^\/research\/([A-Za-z0-9_]{1,15})\.json$/);
  if (rMatch && !hasStaticBoard(rMatch[1].toLowerCase()) && hasDynamicBoard(rMatch[1].toLowerCase())) {
    try { return send(res, 200, readFileSync(join(BOARDS_DIR, rMatch[1].toLowerCase() + '.json'))); } catch {}
  }

  // --- Open Graph share cards ---
  const ogMatch = u.pathname.match(/^\/og\/([A-Za-z0-9_]{1,15})\.png$/);
  if (ogMatch) return sendOG(res, ogMatch[1].toLowerCase());

  // board share URL: serve index.html with per-board OG meta injected so
  // crawlers (X, iMessage) unfurl the right card; the SPA reads the path too.
  const bMatch = u.pathname.match(/^\/b\/([A-Za-z0-9_]{1,15})$/);
  if (bMatch) return sendBoardHTML(res, bMatch[1].toLowerCase());

  if (u.pathname === '/' || u.pathname === '/index.html') return sendBoardHTML(res, null);

  // static files
  let p = u.pathname;
  p = p.replace(/\.\.+/g, ''); // no path traversal
  const file = join(__dirname, p);
  readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[extname(file)] || 'application/octet-stream');
  });
});

// --- OG helpers ---
function boardMeta(handle) {
  try {
    const d = JSON.parse(readFileSync(join(__dirname, 'research', handle + '.json'), 'utf8'));
    return d.meta || null;
  } catch {}
  try {
    // dynamic (auto-built) boards get share cards + crawler meta too
    const d = JSON.parse(readFileSync(join(BOARDS_DIR, handle + '.json'), 'utf8'));
    return d.meta || null;
  } catch { return null; }
}

const CARD_VERSION = 3; // bump when card rendering changes, to invalidate cached PNGs
async function sendOG(res, handle) {
  const m = boardMeta(handle);
  const est = (m && m.estimate) || {};
  // cache key includes the card version AND the current total, so cards
  // auto-refresh when the code changes or the modeled number moves.
  const stamp = CARD_VERSION + '_' + Math.round(est.total || est.floor || 0);
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
      svg = og.cardSVG({ handle: m.account, name: m.name, total: est.total, floor: est.floor, identified: m.identified, researched: m.researched, owner: m.owner });
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

function sendBoardHTML(res, handle) {
  let html;
  try { html = readFileSync(join(__dirname, 'index.html'), 'utf8'); } catch { return send(res, 500, 'error', 'text/plain'); }
  const origin = 'https://networknetworth.fly.dev';
  const m = handle ? boardMeta(handle) : null;
  let title, desc, image;
  if (m) {
    const est = m.estimate || {};
    const total = est.total || est.floor || 0;
    const fmt = (n) => n >= 1e12 ? '$' + (n / 1e12).toFixed(2) + 'T' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n / 1e3) + 'K';
    title = `@${m.account}'s followers are worth ~${fmt(total)} — NetWorkNetWorth`;
    desc = `${(m.identified || 0).toLocaleString()} identified followers, researched floor ${fmt(est.floor || 0)}. See who's rich in @${m.account}'s network.`;
    image = `${origin}/og/${m.account}.png`;
  } else {
    title = 'NetWorkNetWorth — how rich is your network?';
    desc = 'Drop in any X / Twitter profile and see the estimated net worth of their followers.';
    image = `${origin}/og/default.png`;
  }
  const tags = [
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:title" content="${esc(title)}"/>`,
    `<meta property="og:description" content="${esc(desc)}"/>`,
    `<meta property="og:image" content="${image}"/>`,
    `<meta property="og:url" content="${origin}${handle ? '/b/' + handle : '/'}"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`,
    `<meta name="twitter:title" content="${esc(title)}"/>`,
    `<meta name="twitter:description" content="${esc(desc)}"/>`,
    `<meta name="twitter:image" content="${image}"/>`,
  ].join('\n');
  html = html.replace('<!--OG-->', tags);
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(html);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

server.listen(PORT, () => console.log(`NetWorkNetWorth live on http://localhost:${PORT}  (API key ${KEY ? 'loaded' : 'MISSING — synthetic only'})`));
