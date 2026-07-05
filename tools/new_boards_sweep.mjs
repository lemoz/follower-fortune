// Mint new boards from the existing researched pool: for each target account,
// fetch profile + a 2000-follower sample distribution, then sweep every
// identified person against it. Writes new_boards_data.json for assembly.
// Usage: node tools/new_boards_sweep.mjs <handle1> <handle2> ...
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'new_boards_data.json');
const TARGETS = process.argv.slice(2);
if (!TARGETS.length) { console.error('usage: node new_boards_sweep.mjs <handle> ...'); process.exit(1); }
const KEY = readFileSync(join(ROOT, '.env'), 'utf8').match(/^TWITTERAPI_KEY=(.+)$/m)[1].trim();

const people = new Map();
for (const f of readdirSync(join(ROOT, 'research'))) {
  if (!f.endsWith('.json') || f === 'index.json' || f === 'model.json') continue;
  for (const p of JSON.parse(readFileSync(join(ROOT, 'research', f), 'utf8')).people || []) if (p.identified) people.set(p.handle.toLowerCase(), p);
}
console.error('identified pool:', people.size);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, params) {
  const url = new URL('https://api.twitterapi.io' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let a = 0; ; a++) { const r = await fetch(url, { headers: { 'X-API-Key': KEY } }); if (r.status === 429 && a < 4) { await sleep(5000); continue; } return await r.json().catch(() => ({})); }
}
const out = {};
for (const t of TARGETS) {
  const info = await api('/twitter/user/info', { userName: t });
  const d = info.data || {};
  const counts = { b0: 0, b1: 0, b2: 0, b3: 0 };
  let sampled = 0, cursor = '';
  for (let page = 0; page < 20; page++) {
    const j = await api('/twitter/user/followers', { userName: t, cursor, pageSize: 100 });
    if (!Array.isArray(j.followers) || !j.followers.length) break;
    for (const f of j.followers) { const c = f.followers_count || 0; sampled++; if (c < 1e3) counts.b0++; else if (c < 1e4) counts.b1++; else if (c < 1e5) counts.b2++; else counts.b3++; }
    cursor = j.next_cursor || ''; if (!j.has_next_page || !cursor) break; await sleep(200);
  }
  out[t] = { name: d.name || '@' + t, totalFollowers: d.followers || 0, sampleDist: { sampled, ...counts }, members: [] };
  console.error(`${t}: ${out[t].name}, ${out[t].totalFollowers} followers, sample ${sampled}`);
}
const jobs = [];
for (const [h, p] of people) for (const t of TARGETS) jobs.push([p.handle, t]);
console.error('sweep checks:', jobs.length);
let done = 0;
async function worker() {
  while (jobs.length) {
    const [h, t] = jobs.shift();
    const j = await api('/twitter/user/check_follow_relationship', { source_user_name: h, target_user_name: t });
    if (j.data && j.data.following) out[t].members.push(h);
    if (++done % 500 === 0) console.error(done, 'checks done');
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const t of TARGETS) console.error(`${t}: +${out[t].members.length} researched followers`);
