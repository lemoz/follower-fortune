// GLM 5.2 research client (Z.ai / OpenAI-compatible chat completions).
// Used for on-demand board building: researches the account owner and their
// biggest sampled followers. Results are ALWAYS labeled ai-researched and
// unverified — they never enter the curated research/ dataset or the
// leaderboards until they pass the Sonnet verify gate offline.
//
//   .env: GLM_API_KEY   (required for on-demand research)
//         GLM_API_URL   (default https://api.z.ai/api/paas/v4/chat/completions)
//         GLM_MODEL     (default glm-5.2)

// Z.ai (GLM) — endpoint + auth confirmed against docs.z.ai (2026-07-05).
// Model id is 'glm-5' (the dashboard's "GLM-5.2" is branding, not an API id);
// 'glm-5-turbo' is the agent-loop variant. Override with GLM_MODEL.
const GLM_URL = process.env.GLM_API_URL || 'https://api.z.ai/api/paas/v4/chat/completions';
const GLM_MODEL = process.env.GLM_MODEL || 'glm-5';

export function glmAvailable() { return !!process.env.GLM_API_KEY; }

async function glmJSON(system, user, { maxTokens = 4000, timeoutMs = 45_000 } = {}) {
  // Single attempt, 45s cap. (We do NOT use GLM's web_search tool — it doesn't
  // return results on this account and doubled latency; Gemini handles grounding.)
  const body = {
    model: GLM_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens,
    temperature: 0.2,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(GLM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.GLM_API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error('glm http ' + r.status + ': ' + JSON.stringify(j).slice(0, 200));
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) throw new Error('glm empty response');
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text);
  } finally { clearTimeout(timer); }
}

const UNITS_RULE = 'All dollar amounts must be RAW US DOLLARS as JSON numbers: $2 billion = 2000000000, $50 million = 50000000. Never output 2 or 50 to mean billions/millions. If there is no credible public basis for an estimate, say found=false — never invent a number.';

// --- real web search (provider-agnostic) -------------------------------------
// This is what makes estimates CITED rather than guessed: we search, feed the
// real result snippets to GLM, and the sources shown are the REAL result URLs.
// Uses Serper (SERPER_API_KEY) if set — instant, Google results — else Google
// Custom Search (GOOGLE_SEARCH_KEY + GOOGLE_CSE_ID). Either backend, same shape.
const SERPER_KEY = process.env.SERPER_API_KEY;
const GS_KEY = process.env.GOOGLE_SEARCH_KEY;
const GS_CX = process.env.GOOGLE_CSE_ID;
export function searchAvailable() { return !!(SERPER_KEY || (GS_KEY && GS_CX)); }

async function serperSearch(query, num) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, num }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    return (j.organic || []).map((it) => ({ title: it.title, link: it.link, snippet: (it.snippet || '').replace(/\s+/g, ' ').slice(0, 300) }));
  } finally { clearTimeout(timer); }
}

async function googleSearch(query, num) {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', GS_KEY);
  url.searchParams.set('cx', GS_CX);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(Math.max(num, 1), 10)));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const j = await r.json();
    return (j.items || []).map((it) => ({ title: it.title, link: it.link, snippet: (it.snippet || '').replace(/\s+/g, ' ').slice(0, 300) }));
  } finally { clearTimeout(timer); }
}

export async function searchWeb(query, num = 6) {
  const n = Math.min(Math.max(num, 1), 10);
  try {
    if (SERPER_KEY) return await serperSearch(query, n);
    if (GS_KEY && GS_CX) return await googleSearch(query, n);
  } catch { /* fall through */ }
  return [];
}

// Research the board owner's own net worth, GROUNDED on their real X profile
// (self-reported location, bio, external link). profile: {userName, name,
// followers, description, location, link}. `link` should already be resolved
// (t.co -> real destination) by the caller.
export async function researchOwner(profile) {
  // Prefer Gemini + Google-Search grounding (first-party Google) when available.
  try {
    const gem = await import('./gemini.mjs');
    if (gem.geminiAvailable()) {
      const g = await gem.researchOwnerGemini(profile).catch(() => null);
      if (g) return g;
    }
  } catch {}
  const loc = (profile.location || '').trim();
  const link = (profile.link || '').trim();
  // real web search first (if configured) — this is the grounding
  const hits = await searchWeb(`${profile.name} (@${profile.userName}) net worth`, 6).catch(() => []);
  const grounded = hits.length > 0;
  const searchBlock = grounded
    ? '\n\nWeb search results (use these as your PRIMARY evidence; cite the ones you rely on by their [n] index in used_sources):\n' +
      hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}\n${h.link}`).join('\n\n')
    : '';
  const j = await glmJSON(
    'You are a careful wealth researcher. You are given a real X/Twitter profile' + (grounded ? ' AND live web search results' : '') + '. Identify who the person is (role, company, wealth basis) and estimate their personal net worth. ' + UNITS_RULE +
    ' Do NOT invent a location, employer, or URL — only use what is given' + (grounded ? ', the search results,' : '') + ' or what you actually know. Respond with JSON only: {"found":bool,"name":str,"role":str,"headline":str,"basis":str,"low":number,"high":number,"confidence":"low"|"medium"|"high","used_sources":[int]}. "role" = job title + company. "basis" = one sentence on WHY this range (equity, exits, salary, or "no strong public basis"). "used_sources" = indices of the web results you relied on (empty if none).',
    `Real X profile:\n- Handle: @${profile.userName}\n- Name: ${profile.name}\n- Followers: ${(profile.followers || 0).toLocaleString()}\n- Bio: "${profile.description || 'n/a'}"\n- Self-reported location: ${loc || 'n/a'}\n- Linked site: ${link || 'n/a'}${searchBlock}\n\nWho are they, and what is a defensible personal net worth range?`
  );
  if (!j || j.found === false || !(j.low > 0 || j.high > 0)) return null;
  // sources are REAL only: the actual search-result URLs GLM cited, plus the
  // person's X profile + linked site. GLM-claimed URLs are never surfaced.
  const cited = Array.isArray(j.used_sources) ? j.used_sources.map((i) => hits[i - 1] && hits[i - 1].link).filter(Boolean) : [];
  const sources = [...new Set([...cited, 'https://x.com/' + profile.userName, /^https?:\/\//i.test(link) ? link : null].filter(Boolean))].slice(0, 5);
  return {
    name: j.name || profile.name,
    role: String(j.role || '').slice(0, 120),
    headline: String(j.headline || '').slice(0, 200),
    basis: String(j.basis || '').slice(0, 200),
    // NOTE: location is used above as a private grounding hint only — it is
    // deliberately NOT returned/published (pairing home location + wealth = doxxing).
    verdict: grounded ? 'web-researched' : 'ai-researched',
    // search grounding earns up to medium; ungrounded stays capped at low
    confidence: grounded ? (j.confidence === 'high' ? 'high' : j.confidence || 'low') : (j.confidence === 'high' ? 'medium' : 'low'),
    low: Math.round(j.low), high: Math.round(j.high),
    sources,
  };
}

// Research a batch of sampled followers (the biggest ones). One GLM call per
// person keeps failures isolated; the caller bounds N.
export async function researchPerson(f) {
  const j = await glmJSON(
    'You are a careful wealth researcher identifying whether a Twitter/X account belongs to a person with publicly estimable wealth. Use web search when available. Companies, brands, and anonymous accounts are NOT identifiable people: found=false. ' + UNITS_RULE + ' Respond with JSON only: {"found":bool,"name":str,"headline":str,"low":number,"high":number,"confidence":"low"|"medium"|"high","sources":[urls]}',
    `Who is X/Twitter user @${f.userName} ("${f.name}", ${(f.followers || 0).toLocaleString()} followers)? Bio: "${f.description || 'n/a'}". If they are an identifiable person, estimate their net worth range.`
  );
  if (!j || j.found === false || !(j.low > 0 || j.high > 0)) return null;
  return {
    handle: f.userName, name: j.name || f.name, followers: f.followers || 0, identified: true,
    headline: String(j.headline || '').slice(0, 200),
    verdict: 'ai-researched', confidence: j.confidence === 'high' ? 'medium' : 'low',
    low: Math.round(j.low), high: Math.round(j.high),
    sources: [], // GLM hallucinates URLs without live search — see researchOwner
  };
}
