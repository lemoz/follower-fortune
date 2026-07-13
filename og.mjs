// Open Graph share-card rendering. SVG -> PNG via @resvg/resvg-js (lazy,
// fail-soft: any error falls back to a static default card so the site never
// breaks). 1200x630, matches the site's dark/gold identity.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(n) {
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

// data: { handle, name, total, floor, identified, researched, owner:{low,high}, live }
export function cardSVG(data) {
  const W = 1200, H = 630;
  const total = data.total || data.floor || 0;
  const big = '≈ ' + money(total);
  const context = data.live
    ? `${(data.identified || 0).toLocaleString()} est. identifiable · live model`
    : `${(data.identified || 0).toLocaleString()} identified followers · research dossier`;
  const ownLine = data.owner && (data.owner.low || data.owner.high)
    ? `owner estimate ${money(data.owner.low)}–${money(data.owner.high)}` : '';
  const bigSize = big.length > 7 ? 132 : big.length > 5 ? 156 : 176;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="money" x1="0" y1="0" x2="1" y2="0.3">
      <stop offset="0%" stop-color="#ffd24a"/><stop offset="100%" stop-color="#34e0a1"/>
    </linearGradient>
    <radialGradient id="g1" cx="0.85" cy="0" r="0.7">
      <stop offset="0%" stop-color="#a98bff" stop-opacity="0.22"/><stop offset="60%" stop-color="#a98bff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="0" cy="0.15" r="0.6">
      <stop offset="0%" stop-color="#34e0a1" stop-opacity="0.14"/><stop offset="55%" stop-color="#34e0a1" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#070912"/>
  <rect width="${W}" height="${H}" fill="url(#g1)"/>
  <rect width="${W}" height="${H}" fill="url(#g2)"/>
  <text x="72" y="96" font-family="DejaVu Sans" font-size="40" font-weight="bold" fill="#e8ecf6">NetWorkNetWorth</text>
  <text x="510" y="96" font-family="DejaVu Sans" font-size="26" fill="#8b94ad">NWNW</text>
  <text x="72" y="250" font-family="DejaVu Sans" font-size="52" font-weight="bold" fill="#e8ecf6">@${esc(data.handle)}</text>
  <text x="72" y="300" font-family="DejaVu Sans" font-size="30" fill="#8b94ad">Total estimated net worth of followers</text>
  <text x="70" y="${300 + bigSize * 0.72 + 40}" font-family="DejaVu Sans" font-size="${bigSize}" font-weight="bold" fill="url(#money)">${esc(big)}</text>
  <text x="72" y="540" font-family="DejaVu Sans" font-size="30" fill="#aab2c8">${esc(context)}</text>
  ${ownLine ? `<text x="72" y="586" font-family="DejaVu Sans" font-size="25" fill="#ffd24a">${esc(ownLine)}</text>` : ''}
  <text x="${W - 72}" y="586" text-anchor="end" font-family="DejaVu Sans" font-size="26" fill="#5e677f">networknetworth.fly.dev</text>
</svg>`;
}

export function defaultCardSVG() {
  const W = 1200, H = 630;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="money" x1="0" y1="0" x2="1" y2="0.3">
      <stop offset="0%" stop-color="#ffd24a"/><stop offset="100%" stop-color="#34e0a1"/>
    </linearGradient>
    <radialGradient id="g1" cx="0.85" cy="0" r="0.7">
      <stop offset="0%" stop-color="#a98bff" stop-opacity="0.22"/><stop offset="60%" stop-color="#a98bff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#070912"/>
  <rect width="${W}" height="${H}" fill="url(#g1)"/>
  <text x="72" y="300" font-family="DejaVu Sans" font-size="88" font-weight="bold" fill="url(#money)">NetWorkNetWorth</text>
  <text x="72" y="380" font-family="DejaVu Sans" font-size="40" fill="#aab2c8">How rich is your network?</text>
  <text x="72" y="440" font-family="DejaVu Sans" font-size="30" fill="#8b94ad">Follower net-worth estimates based on public-source research.</text>
  <text x="72" y="560" font-family="DejaVu Sans" font-size="28" fill="#5e677f">networknetworth.fly.dev</text>
</svg>`;
}

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fonts');

let ResvgCls = null, resvgTried = false;
export async function renderPNG(svg) {
  if (!resvgTried) { resvgTried = true; try { ({ Resvg: ResvgCls } = await import('@resvg/resvg-js')); } catch (e) { ResvgCls = null; } }
  if (!ResvgCls) return null;
  try {
    // Bundle the font explicitly — never rely on system-font discovery, which
    // silently fails on minimal container images (renders text as nothing).
    const r = new ResvgCls(svg, {
      fitTo: { mode: 'width', value: 1200 },
      font: {
        fontFiles: [join(FONT_DIR, 'DejaVuSans.ttf'), join(FONT_DIR, 'DejaVuSans-Bold.ttf')],
        loadSystemFonts: false,
        defaultFontFamily: 'DejaVu Sans',
      },
    });
    return r.render().asPng();
  } catch (e) { return null; }
}
