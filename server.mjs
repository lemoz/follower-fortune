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

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/lookup') {
    if (!KEY) return send(res, 200, JSON.stringify({ ok: false, error: 'no_api_key', message: 'No TWITTERAPI_KEY found. Add it to .env and restart.' }));
    const handle = (u.searchParams.get('handle') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15).toLowerCase();
    if (!handle) return send(res, 200, JSON.stringify({ ok: false, error: 'bad_handle', message: 'Missing or invalid handle.' }));

    const cap = Math.min(Math.max(parseInt(u.searchParams.get('max'), 10) || 200, 20), HARD_MAX);
    const cacheKey = handle + ':' + cap;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) { logLookup({ handle, cap, cached: 'mem' }); return send(res, 200, hit.payload); }
    // disk cache survives scale-to-zero restarts
    const diskPath = join(CACHE_DIR, cacheKey.replace(/[^a-z0-9_:-]/gi, '') + '.json');
    if (existsSync(diskPath)) {
      try {
        const d = JSON.parse(readFileSync(diskPath, 'utf8'));
        if (Date.now() - d.ts < CACHE_TTL_MS) {
          cache.set(cacheKey, d);
          logLookup({ handle, cap, cached: 'disk' });
          return send(res, 200, d.payload);
        }
      } catch {}
    }

    if (!ipAllowed(clientIp(req)))
      return send(res, 429, JSON.stringify({ ok: false, error: 'rate_limited', message: 'Too many lookups from your address. Try again in a few minutes.' }));
    if (!dailyAllowed())
      return send(res, 429, JSON.stringify({ ok: false, error: 'daily_cap', message: 'Daily lookup budget exhausted. Fresh lookups resume tomorrow (UTC) — cached and researched boards still work.' }));

    try {
      const result = await lookup(handle, cap);
      const payload = JSON.stringify(result);
      if (result.ok) {
        dailyCount++;
        const entry = { ts: Date.now(), payload };
        cache.set(cacheKey, entry);
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
        try { writeFileSync(diskPath, JSON.stringify(entry)); } catch {}
        logLookup({ handle, cap, cached: false, followers: result.totalFollowers, sampled: result.sampleSize });
      } else {
        logLookup({ handle, cap, cached: false, error: result.error });
      }
      return send(res, 200, payload);
    }
    catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: 'server', message: String((e && e.message) || e) })); }
  }

  // static files
  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  p = p.replace(/\.\.+/g, ''); // no path traversal
  const file = join(__dirname, p);
  readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, () => console.log(`NetWorkNetWorth live on http://localhost:${PORT}  (API key ${KEY ? 'loaded' : 'MISSING — synthetic only'})`));
