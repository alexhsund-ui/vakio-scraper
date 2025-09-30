import express from 'express';
import { chromium } from 'playwright';
import pRetry from 'p-retry';

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS för frontend ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // byt till din domän om du vill låsa ned
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Enkel minnescache ---
let CACHE = { ts: 0, data: null };
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

// --- Hjälpfunktioner för normalisering ---
const OUT = ['1', 'X', '2'];
function normalizeAny(json) {
  const out = [];

  function push(g) {
    const home = g?.homeName ?? g?.home ?? g?.homeTeam?.name ?? g?.teams?.[0]?.name ?? g?.competitors?.[0]?.name;
    const away = g?.awayName ?? g?.away ?? g?.awayTeam?.name ?? g?.teams?.[1]?.name ?? g?.competitors?.[1]?.name;
    const choices = g?.choices ?? g?.outcomes ?? g?.selections ?? g?.market?.outcomes;
    if (!home || !away || !Array.isArray(choices) || choices.length < 3) return;

    const percent = { '1': 0, 'X': 0, '2': 0 };
    const odds = {};
    for (let i = 0; i < 3; i++) {
      const c = choices[i] || {};
      const p = Number(c.percentage ?? c.percent ?? c.selectionPercentage ?? c.probabilityPct ?? c.probability);
      const o = Number(c.odds ?? c.price ?? c.decimalOdds ?? c.o);
      if (!Number.isNaN(p)) percent[OUT[i]] = p;
      if (!Number.isNaN(o) && o > 1) odds[OUT[i]] = o;
    }
    if (percent['1'] + percent['X'] + percent['2'] > 0) {
      out.push({
        index: out.length + 1,
        home: String(home),
        away: String(away),
        percent,
        odds: Object.keys(odds).length ? odds : undefined,
      });
    }
  }

  const candidates = [];
  if (Array.isArray(json)) candidates.push(...json);
  if (json && typeof json === 'object') {
    for (const k of ['draw', 'content', 'result']) if (json[k]) candidates.push(json[k]);
    for (const k of ['draws', 'games', 'events', 'rows', 'pairs', 'selections', 'fixtures'])
      if (Array.isArray(json[k])) candidates.push(...json[k]);
  }

  const stack = [...candidates];
  const flat = [];
  while (stack.length) {
    const x = stack.shift();
    if (!x) continue;
    if (Array.isArray(x)) stack.push(...x);
    else if (typeof x === 'object') {
      if (x.choices || x.outcomes || x.selections) flat.push(x);
      for (const v of Object.values(x)) if (v && (typeof v === 'object' || Array.isArray(v))) stack.push(v);
    }
  }
  for (const g of flat) {
    push(g);
    if (out.length >= 13) break;
  }
  return out.slice(0, 13);
}

function implied(odds) {
  if (!odds || odds <= 1e-9) return undefined;
  return 1 / odds;
}
function enrich(matches) {
  return matches.map(m => {
    const a = implied(m.odds?.['1']);
    const b = implied(m.odds?.['X']);
    const c = implied(m.odds?.['2']);
    const s = (a ?? 0) + (b ?? 0) + (c ?? 0);
    const probs = s > 0 ? ({ '1': (a / s) * 100, 'X': (b / s) * 100, '2': (c / s) * 100 }) : undefined;
    const deviation = probs ? ({
      '1': m.percent['1'] - (probs['1'] ?? 0),
      'X': m.percent['X'] - (probs['X'] ?? 0),
      '2': m.percent['2'] - (probs['2'] ?? 0),
    }) : undefined;
    return { ...m, oddsProbPct: probs, deviation };
  });
}

// ——— KÄRNAN: fånga ALLA JSON-svar när vi öppnar sidan ———
async function scrapeViaKohde(kohdeId) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  // anti-bot + språkinställning + cookie-consent
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
    try { localStorage.setItem('LANG', 'sv'); } catch {}
    try {
      const now = new Date();
      const consent = 'isGpcEnabled=0&datestamp=' + now.toISOString() + '&version=6.33.0&hosts=&consentId=fake&interactionCount=1&landingPath=NotApplicable&groups=C0001:1,C0002:1,C0003:1,C0004:1&geolocation=FI;AX&AwaitingReconsent=false';
      localStorage.setItem('OptanonConsent', consent);
    } catch {}
  });

  const captured = []; // {url,status,ct,len,body(sample)}
  const jsonBodies = []; // parsed JSONs

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      const status = resp.status();
      const text = await resp.text();
      captured.push({ url, status, ct, len: text.length, sample: text.slice(0, 300) });
      try {
        const obj = JSON.parse(text);
        jsonBodies.push(obj);
      } catch {}
    } catch {}
  });

  try {
    // 1) Gå till startsida och klicka bort cookies
    await page.goto('https://www.veikkaus.fi/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    const cookieSelectors = [
      '#onetrust-accept-btn-handler',
      'button:has-text("Godkänn")', 'button:has-text("Acceptera")',
      'button:has-text("Hyväksy")', 'button:has-text("OK")'
    ];
    for (const sel of cookieSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click().catch(() => {}); await page.waitForTimeout(300); }
      } catch {}
    }

    // 2) Navigera till kohde-sidan om given; annars försök hitta första “Vakio”-kohde
    let targetUrl;
    if (kohdeId) {
      targetUrl = `https://www.veikkaus.fi/sv/vedonlyonti/vakio?kohde=${encodeURIComponent(kohdeId)}`;
    } else {
      await page.goto('https://www.veikkaus.fi/sv/vedonlyonti', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      // leta efter första länken som ser ut som vakio?kohde=...
      targetUrl = await page.evaluate(() => {
        const as = Array.from(document.querySelectorAll('a[href*="/vedonlyonti/vakio?kohde="]'));
        const cand = as.find(a => a.getAttribute('href') && a.getAttribute('href').includes('vakio?kohde='));
        if (cand) {
          const href = cand.getAttribute('href');
          if (!href) return null;
          if (href.startsWith('http')) return href;
          return new URL(href, location.origin).toString();
        }
        return null;
      });
      if (!targetUrl) {
        // sista utväg: prova “alla objekt”-sida på svenska
        targetUrl = 'https://www.veikkaus.fi/sv/vedonlyonti/vakio';
      }
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    // ge sidan lite tid att ladda in XHR/JSON
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // 3) Försök hitta 13 matcher i fångade JSON-svar
    for (const obj of jsonBodies) {
      const arr = normalizeAny(obj);
      if (arr.length === 13) {
        await browser.close();
        return { ok: true, source: 'xhr-capture', kohde: kohdeId || null, url: targetUrl, matches: enrich(arr), captured };
      }
    }

    // 4) Försök också med inline script JSON (om appen injicerar data i <script>)
    const html = await page.content();
    const jsonBlobs = [];
    const regex = /<script[^>]*>\s*({[\s\S]*?})\s*<\/script>/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      const blob = m[1];
      if (blob && blob.length > 200) jsonBlobs.push(blob);
    }
    for (const blob of jsonBlobs) {
      try {
        const obj = JSON.parse(blob);
        const arr = normalizeAny(obj);
        if (arr.length === 13) {
          await browser.close();
          return { ok: true, source: 'inline-script', kohde: kohdeId || null, url: targetUrl, matches: enrich(arr), captured };
        }
      } catch {}
    }

    // 5) Som sista försök: de gamla endpointsen (kan vara 404/400 ofta)
    const endpoints = [
      'https://www.veikkaus.fi/api/sport-open/v1/games/VAKIO/draws',
      'https://www.veikkaus.fi/api/sport-open-games/v1/games/VAKIO/draws',
      'https://www.veikkaus.fi/api/v1/sport-games/draws?game-names=VAKIO&status=OPEN',
      'https://www.veikkaus.fi/api/v1/sport-games/draws?game-names=SPORT&status=OPEN'
    ];
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-ESA-API-Key': 'ROBOT' };
    const tries = [];
    async function tryFetch(u) {
      return await page.evaluate(async ({ u, headers }) => {
        try {
          const r = await fetch(u, { headers, credentials: 'include' });
          const txt = await r.text();
          return { ok: r.ok, status: r.status, text: txt };
        } catch (e) {
          return { ok: false, status: 0, text: String(e) };
        }
      }, { u, headers });
    }
    for (const u of endpoints) {
      const r = await tryFetch(u);
      tries.push({ url: u, status: r.status, ok: r.ok, sample: r.text ? r.text.slice(0, 200) : '' });
      if (r.ok && r.text && r.text.length > 50) {
        try {
          const obj = JSON.parse(r.text);
          const arr = normalizeAny(obj);
          if (arr.length === 13) {
            await browser.close();
            return { ok: true, source: u, kohde: kohdeId || null, url: targetUrl, matches: enrich(arr), captured, tries };
          }
        } catch {}
      }
    }

    await browser.close();
    return { ok: false, error: 'No 13-match draw found', kohde: kohdeId || null, url: targetUrl, captured, tries };
  } catch (err) {
    await browser.close();
    return { ok: false, error: String(err) };
  }
}

// ——— ROUTES ———
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'vakio-scraper', ts: Date.now() });
});

app.get('/api/veikkaus/stryktips1', async (req, res) => {
  try {
    const force = String(req.query.force || '') === '1';
    const kohde = typeof req.query.kohde === 'string' ? req.query.kohde : undefined;

    // cache-nyckel: olika kohde ska cacheas separat
    const cacheKey = kohde ? `k:${kohde}` : 'k:auto';
    const now = Date.now();

    if (!force && CACHE.data && CACHE.data[cacheKey] && (now - CACHE.ts) < CACHE_TTL_MS) {
      res.set('cache-control', 'public, max-age=60');
      return res.json({ route: 'veikkaus', cached: true, ageSec: Math.round((now - CACHE.ts) / 1000), ...(CACHE.data[cacheKey]) });
    }

    const result = await pRetry(() => scrapeViaKohde(kohde), { retries: 1 });
    if (result.ok) {
      const payload = { ok: true, endpoint: result.source, kohde: result.kohde, url: result.url, matches: result.matches };
      CACHE.data = CACHE.data || {};
      CACHE.data[cacheKey] = payload;
      CACHE.ts = now;
      res.set('cache-control', 'public, max-age=60');
      return res.json({ route: 'veikkaus', cached: false, ...payload });
    } else {
      return res.status(502).json({ route: 'veikkaus', error: result.error || 'unknown', kohde: result.kohde, url: result.url, tries: result.tries || [], captured: (result.captured || []).slice(0, 3) });
    }
  } catch (e) {
    return res.status(500).json({ route: 'veikkaus', error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`vakio-scraper listening on :${PORT}`);
});
