import express from 'express';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 3000;

/** ===== CORS ===== */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // lås till din domän vid behov
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/** ===== In-memory “DB” =====
 * cache[kohde] = {
 *   matches, endpoint, url, updatedAt
 *   inProgress, lastError, lastDebug
 * }
 */
const cache = Object.create(null);

// Chromium “snål-läge” för Render
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

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// blockera tunga resurser
async function throttleResources(page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    route.continue();
  });
}

// scroll för att trigga XHR
async function slowScroll(page, steps = 6, pauseMs = 350) {
  for (let i = 0; i < steps; i++) {
    try { await page.mouse.wheel(0, 900); } catch {}
    await page.waitForTimeout(pauseMs);
  }
}

// försöker plocka 13 matcher ur allt vi ser på sidan
async function tryExtractAll(page, jsonBodies) {
  // a) JSON vi redan fångat
  for (const obj of jsonBodies) {
    const arr = normalizeAny(obj);
    if (arr.length === 13) return { source: 'xhr-capture', matches: arr };
  }
  // b) script[type="application/json"]
  const scriptJsons = await page.$$eval('script[type="application/json"]', nodes =>
    nodes.map(n => n.textContent).filter(Boolean)
  ).catch(() => []);
  for (const s of scriptJsons) {
    try {
      const obj = JSON.parse(s);
      const arr = normalizeAny(obj);
      if (arr.length === 13) return { source: 'script-json', matches: arr };
    } catch {}
  }
  // c) window-probe
  const wndObjs = await page.evaluate(() => {
    const results = [];
    const keys = Object.getOwnPropertyNames(window);
    for (const k of keys) {
      try {
        const v = window[k];
        if (v && typeof v === 'object') results.push(v);
      } catch {}
    }
    return results.slice(0, 60);
  }).catch(() => []);
  for (const obj of wndObjs) {
    try {
      const arr = normalizeAny(obj);
      if (arr.length === 13) return { source: 'window-probe', matches: arr };
    } catch {}
  }
  return null;
}

// själva skrapjobbet (körs i bakgrunden)
async function runJob(kohdeId, debug=false) {
  const key = kohdeId || 'auto';
  if (!cache[key]) cache[key] = {};
  if (cache[key].inProgress) return; // redan igång
  cache[key].inProgress = true;
  cache[key].lastError = null;
  cache[key].lastDebug = null;

  const HARD_BUDGET_MS = 40000; // 40s totalbudget
  const started = Date.now();

  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    locale: 'sv-SE',
    javaScriptEnabled: true,
    extraHTTPHeaders: { 'Accept-Language': 'sv-SE,sv;q=0.9,fi;q=0.8,en;q=0.7' }
  });
  const page = await context.newPage();

  page.setDefaultTimeout(18000);
  page.setDefaultNavigationTimeout(25000);

  await throttleResources(page);

  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
    try { localStorage.setItem('LANG', 'sv'); } catch {}
    try {
      const now = new Date();
      const consent = 'isGpcEnabled=0&datestamp=' + now.toISOString() + '&version=6.33.0&hosts=&consentId=fake&interactionCount=1&landingPath=NotApplicable&groups=C0001:1,C0002:1,C0003:1,C0004:1&geolocation=FI;AX&AwaitingReconsent=false';
      localStorage.setItem('OptanonConsent', consent);
    } catch {}
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
      try { jsonBodies.push(JSON.parse(text)); } catch {}
    } catch {}
  });

  try {
    const baseSv = 'https://www.veikkaus.fi/sv/vedonlyonti/vakio';
    const baseFi = 'https://www.veikkaus.fi/fi/vedonlyonti/vakio';
    const urlSv = kohdeId ? `${baseSv}?kohde=${encodeURIComponent(kohdeId)}` : baseSv;
    const urlFi = kohdeId ? `${baseFi}?kohde=${encodeURIComponent(kohdeId)}` : baseFi;
    const candidates = [urlSv, urlFi];

    // prova båda språken, 2 rundor vardera (med liten paus)
    for (let round = 0; round < 2; round++) {
      for (const url of candidates) {
        if (Date.now() - started > HARD_BUDGET_MS) break;

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(()=>{});
        await slowScroll(page, 6, 300);
        await sleep(800);

        let got = await tryExtractAll(page, jsonBodies);
        if (!got) {
          await sleep(1200);
          got = await tryExtractAll(page, jsonBodies);
        }
        if (got && got.matches?.length === 13) {
          const enriched = enrich(got.matches);
          cache[key] = {
            ...cache[key],
            matches: enriched,
            endpoint: got.source,
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
      await sleep(1200);
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

// Health
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

// Hämta senaste kända data (snabbt svar)
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
