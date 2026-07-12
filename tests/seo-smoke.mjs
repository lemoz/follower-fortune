import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = mkdtempSync(join(tmpdir(), 'nwnw-smoke-'));
const analyticsOffDataDir = mkdtempSync(join(tmpdir(), 'nwnw-smoke-no-ga-'));
const port = 43000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
let analyticsOffChild;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    NWNW_DATA_DIR: dataDir,
    NWNW_DISABLE_RESEARCH: '1',
    TWITTERAPI_KEY: 'smoke-test-no-network',
    GLM_API_KEY: 'smoke-test-no-network',
    GEMINI_API_KEY: 'smoke-test-no-network',
    GA_MEASUREMENT_ID: 'G-TEST123456',
    GOOGLE_SITE_VERIFICATION: 'smoke-verification-token',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function waitForServer(processHandle) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timed out')), 8000);
    processHandle.stdout.on('data', (buf) => {
      if (String(buf).includes('NetWorkNetWorth live')) { clearTimeout(timer); resolve(); }
    });
    processHandle.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code})`)); });
    processHandle.stderr.on('data', (buf) => { if (String(buf).trim()) process.stderr.write(buf); });
  });
}

async function request(path, options = {}) {
  return fetch(origin + path, { redirect: 'manual', ...options });
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => {
    const attrs = {};
    for (const a of m[0].matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[a[1].toLowerCase()] = a[3];
    return attrs;
  });
}

function meta(html, key, value) {
  const row = tags(html, 'meta').find((a) => a[key] === value);
  return row && row.content;
}

function link(html, rel) {
  const row = tags(html, 'link').find((a) => a.rel === rel);
  return row && row.href;
}

function title(html) {
  return html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '';
}

function assertNoForbiddenResearchKeys(value) {
  const forbidden = new Set(['location', 'headline', 'role', 'basis', 'verdict', 'description']);
  const walk = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, childValue] of Object.entries(item)) {
      assert(!forbidden.has(key), `public research payload exposed ${key}`);
      walk(childValue);
    }
  };
  walk(value);
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) assert(allowed.has(key), `${label} exposed unexpected key ${key}`);
}

try {
  const sourceHtml = readFileSync(join(root, 'index.html'), 'utf8');
  const inlineScripts = [...sourceHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter(Boolean);
  for (const [index, source] of inlineScripts.entries()) new vm.Script(source, { filename: `index-inline-${index}.js` });

  await waitForServer(child);

  const rootResponse = await request('/');
  assert.equal(rootResponse.status, 200);
  const rootHtml = await rootResponse.text();
  assert(title(rootHtml).includes('Estimate an X follower network'));
  assert(/speculative/i.test(meta(rootHtml, 'name', 'description') || ''));
  assert.equal(link(rootHtml, 'canonical'), origin + '/');
  assert.equal(meta(rootHtml, 'name', 'google-site-verification'), 'smoke-verification-token');
  assert(rootHtml.includes('window.NWNW_ANALYTICS_ID="G-TEST123456"'));
  assert(rootHtml.includes('loads only if you accept'));
  assert(rootHtml.includes('application/ld+json'));
  assert(!rootHtml.includes('syntheticD('));
  assert(!rootHtml.includes('invented toy'));
  const directory = rootHtml.match(/<nav class="board-directory"[\s\S]*?<\/nav>/)?.[0] || '';
  assert([...directory.matchAll(/href="\/b\/[a-z0-9_]+"/g)].length >= 27);

  const boardResponse = await request('/b/cdossman');
  assert.equal(boardResponse.status, 200);
  const boardHtml = await boardResponse.text();
  assert.notEqual(title(boardHtml), title(rootHtml));
  assert(title(boardHtml).includes('speculative estimate'));
  assert(meta(boardHtml, 'name', 'description')?.startsWith('Speculative estimate, not fact:'));
  assert.equal(link(boardHtml, 'canonical'), origin + '/b/cdossman');
  assert(boardHtml.includes('id="server-summary"'));
  assert(boardHtml.includes('not a verified fact'));

  const mixedCase = await request('/b/CDOSSMAN');
  assert.equal(mixedCase.status, 308);
  assert.equal(mixedCase.headers.get('location'), '/b/cdossman');
  const indexRedirect = await request('/index.html');
  assert.equal(indexRedirect.status, 308);
  assert.equal(indexRedirect.headers.get('location'), '/');

  const missing = await request('/b/nwnwnotfound');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-robots-tag'), 'noindex,nofollow');
  const missingHtml = await missing.text();
  assert.equal(meta(missingHtml, 'name', 'robots'), 'noindex,nofollow');
  assert(missingHtml.includes('No estimate or placeholder number'));

  const robots = await request('/robots.txt');
  assert.equal(robots.status, 200);
  const robotsText = await robots.text();
  assert(robotsText.includes('Disallow: /api/'));
  assert(!robotsText.includes('Disallow: /research/'));
  assert(robotsText.includes(`Sitemap: ${origin}/sitemap.xml`));

  const sitemap = await request('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  const sitemapText = await sitemap.text();
  assert(sitemapText.includes(`<loc>${origin}/</loc>`));
  assert(sitemapText.includes(`<loc>${origin}/privacy</loc>`));
  assert(sitemapText.includes(`<loc>${origin}/b/cdossman</loc>`));
  assert([...sitemapText.matchAll(/<url>/g)].length >= 29);

  const privacy = await request('/privacy');
  assert.equal(privacy.status, 200);
  const privacyHtml = await privacy.text();
  assert.equal(link(privacyHtml, 'canonical'), origin + '/privacy');
  assert(privacyHtml.includes('does not load Google Analytics unless you choose'));

  const boardDataResponse = await request('/research/cdossman.json');
  assert.equal(boardDataResponse.status, 200);
  assert.equal(boardDataResponse.headers.get('x-robots-tag'), 'noindex');
  const boardData = await boardDataResponse.json();
  assertNoForbiddenResearchKeys(boardData);
  assertOnlyKeys(boardData.meta, new Set(['account', 'name', 'totalFollowers', 'researched', 'identified', 'dynamic', 'engine', 'owner', 'sampleDist', 'estimate']), 'public board meta');
  assert.equal(boardData.meta.owner.low, 2_000_000);
  assert.equal(boardData.meta.owner.high, 10_000_000);
  assert.match(boardData.meta.owner.estimateLabel, /not a verified fact/i);
  assert.match(boardData.meta.estimate.estimateLabel, /not a verified fact/i);

  const indexDataResponse = await request('/research/index.json');
  assert.equal(indexDataResponse.status, 200);
  assert.equal(indexDataResponse.headers.get('x-robots-tag'), 'noindex');
  const indexData = await indexDataResponse.json();
  assert(indexData.length >= 27);
  for (const row of indexData) {
    assertOnlyKeys(row, new Set(['handle', 'name', 'total', 'est', 'followers', 'researched', 'identified', 'estimateLabel', 'owner']), 'public index row');
    assert.match(row.estimateLabel, /not a verified fact/i);
  }
  const peopleResponse = await request('/research/people.json');
  assert.equal(peopleResponse.status, 200);
  assert.equal(peopleResponse.headers.get('x-robots-tag'), 'noindex');
  assertNoForbiddenResearchKeys(await peopleResponse.json());

  for (const path of ['/.env', '/.git/config', '/server.mjs', '/tools/owner_worths.json']) {
    assert.equal((await request(path)).status, 404, `${path} must not be public`);
  }
  const favicon = await request('/favicon.svg');
  assert.equal(favicon.status, 200);
  assert((await favicon.text()).includes('<svg'));

  assert.equal((await request('/api/board_request?handle=smoketest')).status, 405);
  assert.equal((await request('/api/board_request?handle=smoketest', { method: 'POST' })).status, 403);
  const disabledBuild = await request('/api/board_request?handle=smoketest', { method: 'POST', headers: { 'x-nwnw-action': 'build' } });
  assert.equal(disabledBuild.status, 200);
  assert.equal((await disabledBuild.json()).status, 'offline');

  // A deployment without a configured Measurement ID must render an inert
  // analytics configuration even if a local .env file contains real secrets.
  const analyticsOffPort = port + 1000;
  const analyticsOffOrigin = `http://127.0.0.1:${analyticsOffPort}`;
  analyticsOffChild = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(analyticsOffPort),
      PUBLIC_ORIGIN: analyticsOffOrigin,
      NWNW_DATA_DIR: analyticsOffDataDir,
      NWNW_DISABLE_RESEARCH: '1',
      GA_MEASUREMENT_ID: 'disabled-for-smoke-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(analyticsOffChild);
  const analyticsOffHtml = await (await fetch(analyticsOffOrigin + '/')).text();
  assert(analyticsOffHtml.includes('window.NWNW_ANALYTICS_ID=""'));
  assert(!analyticsOffHtml.includes('window.NWNW_ANALYTICS_ID="G-'));

  console.log('SEO and launch-readiness smoke checks passed without paid API calls.');
} finally {
  child.kill('SIGTERM');
  if (analyticsOffChild) analyticsOffChild.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(analyticsOffDataDir, { recursive: true, force: true });
}
