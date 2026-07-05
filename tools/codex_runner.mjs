// Codex research runner — fans candidates through `codex exec` at fixed
// concurrency, collecting schema-validated JSON per account.
//
// Usage: node tools/codex_runner.mjs <pool.json> <count> <offset> <outfile> [outdir]
//   pool.json: [{handle, name, followers, bio, boards:[...]}, ...]
//   env: CONC (default 10), EFFORT (default "xhigh" — medium/high measured
//        far lower recall on identical accounts; see project memory)
//
// Hard-won operational notes (independently confirmed by dzhng/skills codex):
//  - `codex exec` BLOCKS FOREVER reading a piped stdin. Every child must have
//    stdin closed (child.stdin.end() below, or `< /dev/null` from a shell).
//  - A backgrounded exec can wedge at startup looking alive at 0% CPU; the
//    per-call timeout below is the backstop, and completed accounts are
//    skipped on re-run, so kill-and-relaunch is always safe.
//  - Worker starts are staggered ~1.5s apart: launching many execs in the
//    same instant can wedge them.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [pool_f, count, offset, outfile, outdirArg] = process.argv.slice(2);
if (!pool_f || !outfile) { console.error('usage: node codex_runner.mjs <pool.json> <count> <offset> <outfile> [outdir]'); process.exit(1); }
const pool = JSON.parse(readFileSync(pool_f, 'utf8')).slice(+offset || 0, (+offset || 0) + (+count || 20));
const OUT = outdirArg || join(HERE, 'codex_out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const CONCURRENCY = +(process.env.CONC || 10);
const EFFORT = process.env.EFFORT || 'xhigh';
const SCHEMA = join(HERE, 'person_schema.json');

const prompt = (p) => `You research ONE Twitter/X account for a net-worth leaderboard (entertainment/research site with disclaimers). Use web search to identify the person, then commit to an answer. You MUST cite the URLs you accessed in sources — an identified entry with an empty sources array is INVALID. Search thoroughly (LinkedIn, personal sites, GitHub, press) before giving up.

ACCOUNT: @${p.handle} — display name "${p.name}", ${p.followers} followers.
BIO: "${p.bio}"

Rules:
1. Identify who this actually is from public sources (their site, LinkedIn, GitHub, company pages, news).
2. A company/brand/protocol/org account -> category "company", identified true if you know which org, low=0 high=0.
3. An identifiable real person -> category "person", estimate an honest WIDE net-worth range in USD from public evidence (role, career stage, company funding/equity, exits). Typical non-famous professionals: $50k-$2M. Founders/execs with known funding or exits: scale accordingly.
4. Cannot identify with reasonable confidence -> identified=false, category "unknown", low=0 high=0, verdict "unfounded".
verdict: supported (direct public wealth evidence) | plausible (reasonable inference from verified role/career) | overstated (identity found, wealth signals weak) | unfounded (no reliable identification).
confidence: low|medium|high — most should be low.
sources: ONLY real URLs you actually accessed. NEVER fabricate a URL. Empty array is fine.
Return handle exactly "${p.handle}", followers ${p.followers}.`;

const run1 = (p) => new Promise((resolve) => {
  const out = join(OUT, p.handle + '.json');
  if (existsSync(out)) {
    try { return resolve({ ...JSON.parse(readFileSync(out, 'utf8')), boards: p.boards }); } catch {}
  }
  const args = ['exec', '-m', 'gpt-5.5', '-c', `model_reasoning_effort="${EFFORT}"`, '--ephemeral',
    '--skip-git-repo-check', '-s', 'read-only',
    '--output-schema', SCHEMA, '-o', out, prompt(p)];
  const child = execFile('codex', args, { timeout: 240_000 }, (err) => {
    if (err) { console.error('ERR ' + p.handle + ': ' + String(err.message).slice(0, 120)); return resolve(null); }
    try { resolve({ ...JSON.parse(readFileSync(out, 'utf8')), boards: p.boards }); }
    catch { resolve(null); }
  });
  child.stdin.end(); // REQUIRED: codex exec blocks forever on an open piped stdin
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queue = [...pool];
const results = [];
let done = 0, failed = 0;
async function worker(i) {
  await sleep(i * 1500); // stagger launches
  while (queue.length) {
    const p = queue.shift();
    let r = await run1(p);
    if (!r) r = await run1(p); // one retry
    if (r) results.push(r); else { failed++; console.error('FAILED: ' + p.handle); }
    done++;
    if (done % 5 === 0) console.error(`${done}/${pool.length} done (${failed} failed)`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
writeFileSync(outfile, JSON.stringify(results, null, 1));
const identVal = results.filter((e) => e.identified && (e.low > 0 || e.high > 0));
console.error(`DONE: ${results.length} ok, ${failed} failed, ${identVal.length} identified w/ value, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
