import express from 'express';
import { chromium } from 'playwright';
import pRetry from 'p-retry';

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Cache ---
let CACHE = { ts: 0, data: {} };
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

// --- Hjälpfunktioner ---
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

  // Samla kandidater
  const candidates = [];
  if (Array.isArray(json)) candidates.push(...json);
  if (json && typeof json === 'object') {
    for (const k of ['draw', 'content', 'result']) if (json[k]) candidates.push(json[k]);
    for (const k of ['draws', 'games', 'events', 'rows', 'pairs', 'selections', 'fixtures'])
      if (Array.isArray(json[k])) candidates.push(...json[k]);
  }

  // BFS igenom hela trädet och plocka “match-liknande” objekt
  const stack = [...candidates];
  const flat = [];
  const seen = new Set();
  while (stack.length) {
    const x = stack.shift();
    if (!x || seen.has(x)) continue;
    seen.add(x);
    if (Array.isArray(x)) stack.push(...x);
    else if (typeof x === 'object') {
      if (x.choices || x.outcomes || x.selections) flat.push(x);
      for (const v of Object.values(x))
        if (v && (typeof v === 'object' || Array.isArray(v))) stack.push(v);
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

// Hjälp: vänta lite och scrolla för att trigga XHR
async function slowScroll(page, steps = 6, pauseMs = 500) {
  for (let i = 0; i < steps; i++) {
    try { await page.mouse.wheel(0, 1000); } catch {}
    await page.waitForTimeout(pauseMs);
  }
}

async function scrapeViaKohde(kohdeId) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    locale: 'sv-SE',
  });
  const page = await context.newPage();

  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
    try { localStorage.setItem('LANG', 'sv'); } catch {}
  });

  const captured = [];
  const jsonBodies = [];

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
    // 1) Hem och cookie-consent
    await page.goto('https://www.veikkaus.fi/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
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

    // 2) Gå till rätt sida
    let targetUrl;
    if (kohdeId) {
      targetUrl = `https://www.veikkaus.fi/sv/vedonlyonti/vakio?kohde=${encodeURIComponent(kohdeId)}`;
    } else {
      targetUrl = 'https://www.veikkaus.fi/sv/vedonlyonti/vakio';
    }

    // Prova på svenska, om tomt så prova finska
    const candidates = [targetUrl, targetUrl.replace('/sv/', '/fi/')];

    for (const url of candidates) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await slowScroll(page, 8, 400); // trigga XHR
      await page.waitForTimeout(2000);

      // 2a) Läs script[type="application/json"]
      const scriptJsons = await page.$$eval('script[type="application/json"]', nodes =>
        nodes.map(n => n.textContent).filter(Boolean)
      ).catch(() => []);
      for (const s of scriptJsons) {
        try {
          const obj = JSON.parse(s);
          const arr = normalizeAny(obj);
          if (arr.length === 13) {
            await browser.close();
            return { ok: true, source: 'script-json', kohde: kohdeId || null, url, matches: enrich(arr), captured };
          }
        } catch {}
      }

      // 2b) Kolla alla fångade XHR/Fetch-svar hittills
      for (const obj of jsonBodies) {
        const arr = normalizeAny(obj);
        if (arr.length === 13) {
          await browser.close();
          return { ok: true, source: 'xhr-capture', kohde: kohdeId || null, url, matches: enrich(arr), captured };
        }
      }

      // 2c) Fösök tvinga inläsning från clienten själv (körs i sidans session)
      const forced = await page.evaluate(async () => {
        // prova att leta i "window" efter stora objekt
        const results = [];
        const keys = Object.getOwnPropertyNames(window);
        for (const k of keys) {
          try {
            const v = window[k];
            if (v && typeof v === 'object') results.push(v);
          } catch {}
        }
        return results.slice(0, 40); // ta inte för många
      }).catch(() => []);
      for (const obj of forced) {
        try {
          const arr = normalizeAny(obj);
          if (arr.length === 13) {
            await browser.close();
            return { ok: true, source: 'window-probe', kohde: kohdeId || null, url, matches: enrich(arr), captured };
          }
        } catch {}
      }

      // 2d) Sista: försök ett par troliga interna REST via fetch inuti sidan
      const restCandidates = [
        '/api/sport-open/v1/games/VAKIO/draws',
        '/api/sport-open-games/v1/games/VAKIO/draws',
        '/api/v1/sport-games/draws?game-names=VAKIO&status=OPEN',
        '/api/v1/sport-games/draws?game-names=SPORT&status=OPEN',
      ];
      for (const rel of restCandidates) {
        const r = await page.evaluate(async (rel) => {
          try {
            const u = new URL(rel, location.origin).toString();
            const resp = await fetch(u, { credentials: 'include' });
            const t = await resp.text();
            return { ok: resp.ok, status: resp.status, text: t };
          } catch (e) {
            return { ok: false, status: 0, text: String(e) };
          }
        }, rel);
        if (r && r.ok && r.text && r.text.length > 50) {
          try {
            const obj = JSON.parse(r.text);
            const arr = normalizeAny(obj);
            if (arr.length === 13) {
              await browser.close();
              return { ok: true, source: rel, kohde: kohdeId || null, url, matches: enrich(arr), captured };
            }
          } catch {}
        }
      }
    }

    await browser.close();
    return { ok: false, error: 'No 13-match draw found', kohde: kohdeId || null, url: candidates[candidates.length - 1], captured: captured.slice(0, 3) };
  } catch (err) {
    await browser.close();
    return { ok: false, error: String(err) };
  }
}

// --- ROUTES ---
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'vakio-scraper', ts: Date.now() });
});

app.get('/api/veikkaus/stryktips1', async (req, res) => {
  try {
    const force = String(req.query.force || '') === '1';
    const kohde = typeof req.query.kohde === 'string' ? req.query.kohde : undefined;

    const cacheKey = kohde ? `k:${kohde}` : 'k:auto';
    const now = Date.now();

    if (!force && CACHE.data[cacheKey] && (now - CACHE.ts) < CACHE_TTL_MS) {
      res.set('cache-control', 'public, max-age=60');
      return res.json({ route: 'veikkaus', cached: true, ageSec: Math.round((now - CACHE.ts) / 1000), ...CACHE.data[cacheKey] });
    }

    const result = await pRetry(() => scrapeViaKohde(kohde), { retries: 1 });
    if (result.ok) {
      const payload = { ok: true, endpoint: result.source, kohde: result.kohde, url: result.url, matches: result.matches };
      CACHE.data[cacheKey] = payload;
      CACHE.ts = now;
      res.set('cache-control', 'public, max-age=60');
      return res.json({ route: 'veikkaus', cached: false, ...payload });
    } else {
      return res.status(502).json({ route: 'veikkaus', error: result.error || 'unknown', kohde: result.kohde, url: result.url, captured: result.captured || [] });
    }
  } catch (e) {
    return res.status(500).json({ route: 'veikkaus', error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`vakio-scraper listening on :${PORT}`);
});
