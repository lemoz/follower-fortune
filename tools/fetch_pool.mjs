// Fetch a fresh candidate pool from a board's deep follower pages.
// Usage: node tools/fetch_pool.mjs <handle> <skipFirst> <want> <outfile>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [handle, skipFirst, want, outfile] = process.argv.slice(2);
const SKIP = +skipFirst || 0, WANT = +want || 200;
const KEY = readFileSync(join(ROOT, '.env'), 'utf8').match(/^TWITTERAPI_KEY=(.+)$/m)[1].trim();

const researched = new Set();
for (const f of readdirSync(join(ROOT, 'research'))) {
  if (!f.endsWith('.json') || f === 'index.json' || f === 'model.json') continue;
  for (const p of JSON.parse(readFileSync(join(ROOT, 'research', f), 'utf8')).people || []) researched.add(p.handle.toLowerCase());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = []; let scanned = 0, cursor = '';
for (let page = 0; page < 400 && pool.length < WANT; page++) {
  const url = new URL('https://api.twitterapi.io/twitter/user/followers');
  url.searchParams.set('userName', handle); url.searchParams.set('cursor', cursor); url.searchParams.set('pageSize', '100');
  let j = {};
  for (let a = 0; ; a++) { const r = await fetch(url, { headers: { 'X-API-Key': KEY } }); if (r.status === 429 && a < 4) { await sleep(5000); continue; } j = await r.json().catch(() => ({})); break; }
  if (!Array.isArray(j.followers) || !j.followers.length) break;
  scanned += j.followers.length;
  if (scanned > SKIP) for (const f of j.followers) {
    const c = f.followers_count || 0;
    if (c >= 1000 && f.userName && !researched.has(f.userName.toLowerCase())) pool.push({ handle: f.userName, name: f.name || '@' + f.userName, followers: c, bio: (f.description || '').slice(0, 160), boards: [handle.toLowerCase()] });
  }
  cursor = j.next_cursor || ''; if (!j.has_next_page || !cursor) break;
  await sleep(200);
}
writeFileSync(outfile, JSON.stringify(pool, null, 1));
console.error(`${handle}: scanned ${scanned}, fresh 1k+ candidates: ${pool.length} -> ${outfile}`);
