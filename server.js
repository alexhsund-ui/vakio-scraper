import express from 'express';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 3000;

/** ===== CORS ===== */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // byt till din domän om du vill låsa ned
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/** ===== Enkel “databas” i minnet =====
 * cache[kohde] = {
 *   matches, endpoint, url, updatedAt
 *   inProgress, lastError, lastDebug
 * }
 */
const cache = Object.create(null);

// Chromium “snål-läge”
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
  '--disable-background-networking',
  '--disable-extensions',
  '--disable-default-apps',
  '--mute-audio',
  '--no-first-run'
];

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
  const seen = new Set();
  while (stack.length) {
    const x = stack.shift();
    if (!x || (typeof x === 'object' && seen.has(x))) continue;
    if (typeof x === 'object') seen.add(x);
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

// liten hjälpare – abortera ett steg om det tar >ms
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label||'step'} timeout ${ms}ms`)), ms))
  ]);
}

// själva skrapjobbet (körs i bakgrunden)
async function runJob(kohdeId, debug=false) {
  const key = kohdeId || 'auto';
  if (!cache[key]) cache[key] = {};
  if (cache[key].inProgress) return; // redan igång
  cache[key].inProgress = true;
  cache[key].lastError = null;
  cache[key].lastDebug = null;

  const HARD_BUDGET_MS = 30000; // totalbudget per jobb (30s)
  const started = Date.now();

  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    locale: 'sv-SE',
    javaScriptEnabled: true,
  });
  const page = await context.newPage();

  // blockera tunga resurser
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    route.continue();
  });

  // fånga JSON
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
      try { jsonBodies.push(JSON.parse(text)); } catch {}
    } catch {}
  });

  try {
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(20000);

    await context.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
      try { localStorage.setItem('LANG', 'sv'); } catch {}
      try {
        const now = new Date();
        const consent = 'isGpcEnabled=0&datestamp=' + now.toISOString() + '&version=6.33.0&hosts=&consentId=fake&interactionCount=1&landingPath=NotApplicable&groups=C0001:1,C0002:1,C0003:1,C0004:1&geolocation=FI;AX&AwaitingReconsent=false';
        localStorage.setItem('OptanonConsent', consent);
      } catch {}
    });

    // Gå till hemsidan (snabbt)
    await withTimeout(page.goto('https://www.veikkaus.fi/', { waitUntil: 'domcontentloaded' }), 8000, 'home');

    // Bygg mål-URL
    const baseSv = 'https://www.veikkaus.fi/sv/vedonlyonti/vakio';
    const baseFi = 'https://www.veikkaus.fi/fi/vedonlyonti/vakio';
    const urlSv = kohdeId ? `${baseSv}?kohde=${encodeURIComponent(kohdeId)}` : baseSv;
    const urlFi = kohdeId ? `${baseFi}?kohde=${encodeURIComponent(kohdeId)}` : baseFi;

    // prova på sv, sen fi
    for (const url of [urlSv, urlFi]) {
      if (Date.now() - started > HARD_BUDGET_MS) break;

      await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded' }), 12000, 'goto-vakio');
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(()=>{});
      // liten scroll för att trigga XHR
      for (let i=0;i<4;i++){ try{ await page.mouse.wheel(0, 800);}catch{} await page.waitForTimeout(250); }

      // Försök plocka från fångade JSON
      for (const obj of jsonBodies) {
        const arr = normalizeAny(obj);
        if (arr.length === 13) {
          const enriched = enrich(arr);
          cache[key] = {
            ...cache[key],
            matches: enriched,
            endpoint: 'xhr-capture',
            url,
            updatedAt: Date.now(),
            inProgress: false,
            lastError: null,
            lastDebug: debug ? { captured: captured.slice(0,5) } : null
          };
          await browser.close();
          return;
        }
      }

      // Script JSON
      const scriptJsons = await page.$$eval('script[type="application/json"]', nodes =>
        nodes.map(n => n.textContent).filter(Boolean)
      ).catch(()=>[]);
      for (const s of scriptJsons) {
        try {
          const obj = JSON.parse(s);
          const arr = normalizeAny(obj);
          if (arr.length === 13) {
            const enriched = enrich(arr);
            cache[key] = {
              ...cache[key],
              matches: enriched,
              endpoint: 'script-json',
              url,
              updatedAt: Date.now(),
              inProgress: false,
              lastError: null,
              lastDebug: debug ? { captured: captured.slice(0,5) } : null
            };
            await browser.close();
            return;
          }
        } catch {}
      }
    }

    // Lyckades inte
    cache[key].inProgress = false;
    cache[key].lastError = 'No 13-match draw found';
    cache[key].lastDebug = debug ? { captured: captured.slice(0,5) } : null;
    await browser.close();
  } catch (err) {
    cache[key].inProgress = false;
    cache[key].lastError = String(err?.message || err);
    cache[key].lastDebug = debug ? { captured: captured.slice(0,5) } : null;
    try { await browser.close(); } catch {}
  }
}

/** ===== ROUTES ===== */

// Hälso-check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'vakio-scraper', ts: Date.now() });
});

// Kicka igång skrapning i bakgrunden (svarar direkt)
app.get('/api/veikkaus/kick', async (req, res) => {
  const kohde = typeof req.query.kohde === 'string' ? req.query.kohde : undefined;
  const force = String(req.query.force || '') === '1';
  const debug = String(req.query.debug || '') === '1';
  const key = kohde || 'auto';

  if (!cache[key]) cache[key] = {};
  if (force || !cache[key].inProgress) {
    runJob(kohde, debug).catch(()=>{});
    cache[key].inProgress = true;
  }

  res.json({
    ok: true,
    message: 'Job started (background)',
    kohde: kohde || null,
    inProgress: true
  });
});

// Hämta senaste kända data (svarar alltid snabbt)
app.get('/api/veikkaus/last', (req, res) => {
  const kohde = typeof req.query.kohde === 'string' ? req.query.kohde : undefined;
  const key = kohde || 'auto';
  const item = cache[key];

  if (!item || !item.matches) {
    return res.json({
      ok: false,
      kohde: kohde || null,
      inProgress: !!(item && item.inProgress),
      lastError: item?.lastError || null,
      updatedAt: item?.updatedAt || null,
      debug: item?.lastDebug || null
    });
  }

  res.json({
    ok: true,
    kohde: kohde || null,
    inProgress: !!item.inProgress,
    endpoint: item.endpoint,
    url: item.url,
    updatedAt: item.updatedAt,
    matches: item.matches,
    debug: item.lastDebug || null
  });
});

app.listen(PORT, () => {
  console.log(`vakio-scraper listening on :${PORT}`);
});
