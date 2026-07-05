// Mint new boards end-to-end from the existing researched pool.
//
//   node tools/mint_boards.mjs <target1> <target2> ...
//
// For each target: fetch profile + 2k-follower sample distribution, sweep every
// identified person in the pool via the follow-relationship API, and assemble
// research/<target>.json (only if overlap >= MIN_OVERLAP). Owner net worths are
// read from tools/owner_worths.json (pre-researched via Sonnet). Finishes by
// rebuilding research/index.json and research/people.json.
//
// Aborts early with a clear message if the API reports credit exhaustion —
// don't waste an hour firing 10k failing calls.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'research');
const MIN_OVERLAP = 50;
const KEY = readFileSync(join(ROOT, '.env'), 'utf8').match(/^TWITTERAPI_KEY=(.+)$/m)[1].trim();
const MODEL = JSON.parse(readFileSync(join(RES, 'model.json'), 'utf8'));
const OWNERS = existsSync(join(ROOT, 'tools', 'owner_worths.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'tools', 'owner_worths.json'), 'utf8')) : {};

const targets = process.argv.slice(2).map((t) => t.replace(/^@/, ''));
if (!targets.length) { console.error('usage: node tools/mint_boards.mjs <handle> ...'); process.exit(1); }
for (const t of targets) if (existsSync(join(RES, t.toLowerCase() + '.json'))) { console.error(`SKIP ${t}: board already exists`); targets.splice(targets.indexOf(t), 1); }

// --- pool: every identified person, richest sighting wins ---
const pool = new Map();
for (const f of readdirSync(RES)) {
  if (!f.endsWith('.json') || ['index.json', 'model.json', 'people.json'].includes(f)) continue;
  for (const p of JSON.parse(readFileSync(join(RES, f), 'utf8')).people || []) {
    if (!p.identified) continue;
    const k = p.handle.toLowerCase();
    const prev = pool.get(k);
    if (!prev || ((p.low + p.high) / 2) > ((prev.low + prev.high) / 2)) pool.set(k, p);
  }
}
console.error(`pool: ${pool.size} identified people; targets: ${targets.join(', ')}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let creditFailures = 0;
async function api(path, params) {
  const url = new URL('https://api.twitterapi.io' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let a = 0; ; a++) {
    const r = await fetch(url, { headers: { 'X-API-Key': KEY } });
    if (r.status === 429 && a < 4) { await sleep(5000); continue; }
    const j = await r.json().catch(() => ({}));
    if (j && j.message && /credits/i.test(j.message)) {
      if (++creditFailures > 20) { console.error('\nABORT: twitterapi.io says "' + j.message + '" — recharge and re-run (already-minted boards are kept).'); process.exit(2); }
    }
    return j;
  }
}

// --- per-target: profile + sample distribution ---
const boards = {};
for (const t of targets) {
  const info = await api('/twitter/user/info', { userName: t });
  const d = info.data || {};
  if (!d.userName) { console.error(`${t}: profile fetch failed (${JSON.stringify(info).slice(0, 80)}) — skipping`); continue; }
  const c = { b0: 0, b1: 0, b2: 0, b3: 0 };
  let sampled = 0, cursor = '';
  for (let page = 0; page < 20; page++) {
    const j = await api('/twitter/user/followers', { userName: t, cursor, pageSize: 100 });
    if (!Array.isArray(j.followers) || !j.followers.length) break;
    for (const f of j.followers) { const n = f.followers_count || 0; sampled++; if (n < 1e3) c.b0++; else if (n < 1e4) c.b1++; else if (n < 1e5) c.b2++; else c.b3++; }
    cursor = j.next_cursor || ''; if (!j.has_next_page || !cursor) break;
    await sleep(200);
  }
  boards[t] = { account: d.userName, name: '@' + d.userName, totalFollowers: d.followers || 0, sampleDist: { sampled, ...c }, members: [] };
  console.error(`${t}: ${boards[t].totalFollowers.toLocaleString()} followers, sampled ${sampled}`);
}

// --- sweep pool x targets ---
const jobs = [];
for (const [, p] of pool) for (const t of Object.keys(boards)) jobs.push([p, t]);
console.error(`sweep: ${jobs.length} relationship checks`);
let done = 0;
async function worker() {
  while (jobs.length) {
    const [p, t] = jobs.shift();
    const j = await api('/twitter/user/check_follow_relationship', { source_user_name: p.handle, target_user_name: t });
    if (j.data && j.data.following) boards[t].members.push(p);
    if (++done % 500 === 0) console.error(`  ${done} checks, hits so far: ${Object.values(boards).map((b) => b.members.length).join('/')}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

// --- assemble boards ---
function estimate(meta, floor) {
  const { sampled, b0, b1, b2, b3 } = meta.sampleDist;
  const s = sampled || 1;
  const q = (b1 + b2 + b3) / s;
  const R = { ...MODEL.identRates };
  R.b0 = Math.max(0.002, Math.min(MODEL.identRates.b0, MODEL.identRates.b0 * q / MODEL.qAnchor));
  const remainder = Math.max(0, meta.totalFollowers - meta.researched);
  let est = floor;
  for (const [k, n] of [['b0', b0], ['b1', b1], ['b2', b2], ['b3', b3]])
    est += remainder * (n / s) * R[k] * MODEL.bucketMeans[k];
  return { total: est, low: est / MODEL.errorFactor, high: est * MODEL.errorFactor, floor };
}

const shipped = [];
for (const [t, b] of Object.entries(boards)) {
  if (b.members.length < MIN_OVERLAP) { console.error(`${t}: only ${b.members.length} members (<${MIN_OVERLAP}) — NOT shipping`); continue; }
  const people = b.members.slice().sort((x, y) => ((y.low + y.high) / 2) - ((x.low + x.high) / 2));
  const floor = people.reduce((a, p) => a + (p.low + p.high) / 2, 0);
  const meta = {
    account: b.account, name: b.name, totalFollowers: b.totalFollowers,
    researched: people.length, identified: people.length,
    note: 'Board seeded from the cross-account researched pool: every entry verified as a follower via the X follow-relationship API. Evidence-based ranges with adversarial verification.',
    sampleDist: b.sampleDist,
  };
  const own = OWNERS[t.toLowerCase()];
  if (own && own.found !== false && (own.low || own.high)) meta.owner = { name: own.name, headline: own.headline, verdict: own.verdict, confidence: own.confidence, low: own.low, high: own.high, sources: own.sources || [] };
  meta.estimate = estimate(meta, floor);
  writeFileSync(join(RES, b.account.toLowerCase() + '.json'), JSON.stringify({ meta, people }, null, 1));
  shipped.push(b.account);
  console.error(`SHIPPED ${b.account}: ${people.length} members, floor $${(floor / 1e9).toFixed(2)}B, modeled $${(meta.estimate.total / 1e9).toFixed(2)}B`);
}

// --- rebuild index.json from all board files, then people.json ---
const rows = [];
for (const f of readdirSync(RES)) {
  if (!f.endsWith('.json') || ['index.json', 'model.json', 'people.json'].includes(f)) continue;
  const m = JSON.parse(readFileSync(join(RES, f), 'utf8')).meta;
  const row = { handle: m.account, name: m.name, total: (m.estimate && m.estimate.floor) || 0, est: (m.estimate && m.estimate.total) || 0, followers: m.totalFollowers, researched: m.researched, identified: m.identified };
  if (m.owner) row.owner = { low: m.owner.low, high: m.owner.high };
  rows.push(row);
}
rows.sort((a, b) => b.est - a.est);
writeFileSync(join(RES, 'index.json'), JSON.stringify(rows, null, 1));
execFileSync('node', [join(ROOT, 'tools', 'build_people.mjs')], { stdio: 'inherit' });
console.error(`\nDONE: shipped ${shipped.length} boards (${shipped.join(', ')}); index rebuilt with ${rows.length} boards.`);
console.error('Next: git add -A && git commit && git push (CI deploys).');
