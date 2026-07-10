// Gemini "Grounding with Google Search" — first-party Google search built into
// the Gemini API. One call searches Google AND reasons, returning an answer
// plus groundingMetadata with the REAL source URLs it used. This is how the
// owner net-worth estimate becomes citation-backed with Google's own search.
//
//   .env / Fly secret: GEMINI_API_KEY   (from aistudio.google.com/apikey)
//                      GEMINI_MODEL      (default gemini-2.5-flash)

const GEMINI_KEY = process.env.GEMINI_API_KEY;
// 'latest' alias so a model deprecation doesn't silently break grounding (as
// gemini-2.5-flash did for new keys). Override with GEMINI_MODEL if needed.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
export function geminiAvailable() { return !!GEMINI_KEY; }

const UNITS = 'Dollar amounts must be RAW US DOLLARS as JSON numbers: $2 billion = 2000000000, $50 million = 50000000. Never output 2 or 50 for billions/millions.';

// Research the owner's net worth using Gemini + Google Search grounding.
// profile: {userName, name, followers, description, location, link}
export async function researchOwnerGemini(profile) {
  const loc = (profile.location || '').trim();
  const prompt = `Research the personal net worth of the X/Twitter user @${profile.userName} ("${profile.name}", ${(profile.followers || 0).toLocaleString()} followers). Bio: "${profile.description || 'n/a'}". Self-reported location: ${loc || 'n/a'}. Linked site: ${profile.link || 'n/a'}.

Use Google Search. Identify who they are (role + company) and estimate a defensible personal net-worth range from what's publicly known (equity, exits, funding, salary). ${UNITS} If there is no credible public basis, set found=false.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"found":bool,"name":str,"role":str,"basis":str,"low":number,"high":number,"confidence":"low"|"medium"|"high"}
"basis" = one sentence on WHY this range.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let body;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: ctrl.signal,
    });
    body = await r.json();
    if (!r.ok) throw new Error('gemini http ' + r.status + ': ' + JSON.stringify(body).slice(0, 200));
  } finally { clearTimeout(timer); }

  const cand = body && body.candidates && body.candidates[0];
  if (!cand) return null;
  const text = (cand.content && cand.content.parts || []).map((p) => p.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || j.found === false || !(j.low > 0 || j.high > 0)) return null;

  // REAL citations from Gemini's grounding metadata (the sources Google Search
  // actually surfaced), plus the person's own X profile + link.
  const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const webSources = chunks.map((c) => c.web && c.web.uri).filter(Boolean);
  const sources = [...new Set([...webSources, 'https://x.com/' + profile.userName, /^https?:\/\//i.test(profile.link || '') ? profile.link : null].filter(Boolean))].slice(0, 5);

  // location used only as a private grounding hint (loc in the prompt) — NOT published.
  // honest labeling: only "web-researched" when Google Search actually returned
  // sources; otherwise it's an ungrounded guess with no citations.
  const grounded = webSources.length > 0;
  return {
    name: j.name || profile.name,
    role: String(j.role || '').slice(0, 120),
    basis: String(j.basis || '').slice(0, 200),
    verdict: grounded ? 'web-researched' : 'ai-researched',
    confidence: grounded ? (j.confidence === 'high' ? 'high' : (j.confidence || 'medium')) : 'low',
    low: Math.round(j.low), high: Math.round(j.high),
    sources: grounded ? sources : [],
    engine: GEMINI_MODEL,
  };
}
