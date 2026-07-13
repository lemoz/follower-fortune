// Build research/people.json — the richest INDIVIDUAL people across all boards,
// ranked by their own net worth. Aggregates every board owner (meta.owner) plus
// every identified researched follower, deduped by handle, companies excluded.
// Run after any research merge (alongside the index rebuild).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'research');

const byHandle = new Map(); // handleLower -> record (keep the richest sighting)
function consider(rec) {
  const low = rec.low || 0, high = rec.high || 0;
  if (!rec.handle || (low <= 0 && high <= 0)) return;
  const mid = (low + high) / 2;
  const key = rec.handle.toLowerCase();
  const prev = byHandle.get(key);
  if (!prev || mid > prev.mid) byHandle.set(key, { ...rec, mid });
}

for (const f of readdirSync(RES)) {
  if (!f.endsWith('.json') || f === 'index.json' || f === 'model.json' || f === 'people.json') continue;
  const d = JSON.parse(readFileSync(join(RES, f), 'utf8'));
  const m = d.meta || {};
  // board owner
  if (m.owner && (m.owner.low || m.owner.high)) {
    consider({ handle: m.account, name: m.owner.name, headline: m.owner.headline, verdict: m.owner.verdict, confidence: m.owner.confidence, low: m.owner.low, high: m.owner.high, sources: m.owner.sources || [], kind: 'owner', board: m.account });
  }
  // researched followers (people only — companies are $0 and excluded by the mid check)
  for (const p of d.people || []) {
    if (!p.identified) continue;
    consider({ handle: p.handle, name: p.name, headline: p.headline, verdict: p.verdict, confidence: p.confidence, low: p.low, high: p.high, sources: p.sources || [], kind: 'person', board: m.account });
  }
}

const ranked = [...byHandle.values()].sort((a, b) => b.mid - a.mid).slice(0, 300)
  .map((r) => ({ handle: r.handle, name: r.name, low: r.low, high: r.high, verdict: r.verdict, confidence: r.confidence, headline: (r.headline || '').slice(0, 160), source: (r.sources && r.sources[0]) || '', kind: r.kind }));

writeFileSync(join(RES, 'people.json'), JSON.stringify(ranked, null, 1));
console.error(`people.json: ${ranked.length} ranked (of ${byHandle.size} unique with a net worth)`);
for (const r of ranked.slice(0, 12)) console.error(`  ${(r.name || r.handle).slice(0, 26).padEnd(26)} $${(r.low / 1e6).toFixed(0)}M-$${(r.high / 1e6).toFixed(0)}M  ${r.kind}`);
