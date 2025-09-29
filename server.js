import express from 'express';
import { chromium } from 'playwright';
import pRetry from 'p-retry';

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS: tillåt frontend från vilken domän som helst (enkelt) ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // eller byt till din/domäner
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Enkel minnescache så vi inte spammar sajten
let CACHE = { ts: 0, data: null };
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

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
      const p = Number(
        c.percentage ?? c.percent ?? c.selectionPercentage ?? c.probabilityPct ?? c.probability
      );
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

async function fetchVeikkausDraw() {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
  });

  try {
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

    await page.goto('https://www.veikkaus.fi/sv/vedonlyonti', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const endpoints = [
      'https://www.veikkaus.fi/api/sport-open/v1/games/VAKIO/draws',
      'https://www.veikkaus.fi/api/sport-open-games/v1/games/VAKIO/draws',
      'https://www.veikkaus.fi/api/v1/sport-games/draws?game-names=VAKIO&status=OPEN',
      'https://www.veikkaus.fi/api/v1/sport-games/draws?game-names=SPORT&status=OPEN'
    ];
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-ESA-API-Key': 'ROBOT' };

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

    const tries = [];
    for (const u of endpoints) {
      const r = await tryFetch(u);
      tries.push({ url: u, status: r.status, ok: r.ok, sample: r.text ? r.text.slice(0, 200) : '' });
      if (r.ok && r.text && r.text.length > 50) {
        let data = null;
        try { data = JSON.parse(r.text); } catch {}
        if (data) {
          const candidates = [];
          if (Array.isArray(data)) candidates.push(...data);
          else if (data && typeof data === 'object') {
            if (Array.isArray(data.draws)) candidates.push(...data.draws);
            else candidates.push(data);
          }
          let matches = [];
          const push = arr => { if (!matches.length && arr.length === 13) matches = arr; };
          for (const d of candidates) {
            const arr = normalizeAny(d);
            push(arr);
            if (matches.length === 13) break;
          }
          if (matches.length !== 13) {
            const arr = normalizeAny(data);
            push(arr);
          }
          if (matches.length === 13) {
            await browser.close();
            return { ok: true, source: u, tries, matches: enrich(matches) };
          }
        }
      }
    }

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
        const matches = normalizeAny(obj);
        if (matches.length === 13) {
          await browser.close();
          return { ok: true, source: 'inline-script', tries: [], matches: enrich(matches) };
        }
      } catch {}
    }

    await browser.close();
    return { ok: false, error: 'No 13-match draw found', tries };
  } catch (err) {
    await browser.close();
    return { ok: false, error: String(err) };
  }
}

// Hälso-check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'vakio-scraper', ts: Date.now() });
});

// Huvud-API: /api/veikkaus/stryktips1
app.get('/api/veikkaus/stryktips1', async (req, res) => {
  try {
    const force = String(req.query.force || '') === '1';
    const now = Date.now();
    if (!force && CACHE.data && (now - CACHE.ts) < CACHE_TTL_MS) {
      res.set('cache-control', 'public, max-age=60');
      return res.json({ route: 'veikkaus', cached: true, ageSec: Math.round((now - CACHE.ts) / 1000), ...CACHE.data });
    }

    const result = await pRetry(() => fetchVeikkausDraw(), { retries: 2 });
    if (result.ok) {
      CACHE = { ts: now, data: { ok: true, endpoint: result.source, matches: result.matches } };
      res.set('cache-control', 'public, max-age=60');
      return res.json({ route: 'veikkaus', cached: false, endpoint: result.source, matches: result.matches });
    } else {
      return res.status(502).json({ route: 'veikkaus', error: result.error || 'unknown', tries: result.tries || [] });
    }
  } catch (e) {
    return res.status(500).json({ route: 'veikkaus', error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`vakio-scraper listening on :${PORT}`);
});
