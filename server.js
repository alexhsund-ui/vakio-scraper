import express from 'express';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 3000;

/** ===== CORS ===== */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // lås till din domän om du vill
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/** ===== In-memory cache =====
 * cache[key] = {
 *   matches, endpoint, url, kohde, updatedAt,
 *   inProgress, lastError, lastDebug
 * }
 * key = 'auto' eller exakt kohde-id, t.ex. 'a_100522'
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

async function throttleResources(page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    route.continue();
  });
}

async function slowScroll(page, steps = 6, pauseMs = 300) {
  for (let i = 0; i < steps; i++) {
    try { await page.mouse.wheel(0, 900); } catch {}
    await page.waitForTimeout(pauseMs);
  }
}

/** Försök hitta 13 matcher i allt vi ser på sidan */
async function tryExtractAll(page, jsonBodies) {
  // a) JSON som fångats via XHR
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

/** Hitta aktuella kohde-id från vakio-listan (sv + fi) */
async function discoverKohdeIds(context) {
  const page = await context.newPage();
  const ids = new Set();

  // blockera tunga resurser
  await throttleResources(page);

  const listPages = [
    'https://www.veikkaus.fi/sv/vedonlyonti/vakio',
    'https://www.veikkaus.fi/fi/vedonlyonti/vakio',
  ];

  for (const url of listPages) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await slowScroll(page, 4, 250);

      // Plocka kohde från <a href="...vakio?kohde=...">
      const hrefIds = await page.$$eval('a[href*="vakio?kohde="]', els =>
        els.map(a => {
          try {
            const u = new URL(a.href);
            return u.searchParams.get('kohde');
          } catch { return null; }
        }).filter(Boolean)
      );
      hrefIds.forEach(k => ids.add(k));

      // Plocka kohde även från text (fallback)
      const textIds = await page.evaluate(() => {
        const rx = /\bkohde=a_\d{6,}\b/gi;
        const all = new Set();
        function scan(txt){ let m; while((m = rx.exec(txt))){ const id = m[0].split('=')[1]; all.add(id); } }
        scan(document.documentElement.innerHTML);
        return Array.from(all);
      });
      textIds.forEach(k => ids.add(k));

    } catch (e) {
      // fortsätt nästa sida
    }
  }

  // sortera nyast först (a_100522 > a_100516)
  const sorted = Array.from(ids).sort((a, b) => {
    const pa = parseInt(String(a).replace(/\D+/g,''), 10);
    const pb = parseInt(String(b).replace(/\D+/g,''), 10);
    return pb - pa;
  });

  return sorted;
}

/** Kör scraping-jobb för specifik kohde */
async function runJobForKohde(kohdeId, debug=false) {
  const key = kohdeId;
  if (!cache[key]) cache[key] = {};
  if (cache[key].inProgress) return;

  cache[key].inProgress = true;
  cache[key].lastError = null;
  cache[key].lastDebug = null;

  const HARD_BUDGET_MS = 40000;
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
    const urlSv = `${baseSv}?kohde=${encodeURIComponent(kohdeId)}`;
    const urlFi = `${baseFi}?kohde=${encodeURIComponent(kohdeId)}`;
    const candidates = [urlSv, urlFi];

    for (let round = 0; round < 2; round++) {
      for (const url of candidates) {
        if (Date.now() - started > HARD_BUDGET_MS) break;

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(()=>{});
        await slowScroll(page, 6, 250);
        await sleep(800);

        let got = await tryExtractAll(page, jsonBodies);
        if (!got) {
          await sleep(1000);
          got = await tryExtractAll(page, jsonBodies);
        }
        if (got && got.matches?.length === 13) {
          const enriched = enrich(got.matches);
          cache[key] = {
            ...cache[key],
            matches: enriched,
            endpoint: got.source,
            url,
            kohde: kohdeId,
            updatedAt: Date.now(),
            inProgress: false,
            lastError: null,
            lastDebug: debug ? { captured: captured.slice(0,5) } : null
          };
          await browser.close();
          return { ok: true, kohde: kohdeId };
        }
      }
      await sleep(800);
    }

    cache[key].inProgress = false;
    cache[key].lastError = 'No 13-match draw found';
    cache[key].lastDebug = debug ? { captured: captured.slice(0,5) } : null;
    await browser.close();
    return { ok: false, error: 'No 13-match draw found' };
  } catch (err) {
    cache[key].inProgress = false;
    cache[key].lastError = String(err?.message || err);
    cache[key].lastDebug = debug ? { captured: captured.slice(0,5) } : null;
    try { await browser.close(); } catch {}
    return { ok: false, error: String(err?.message || err) };
  }
}

/** Auto-läge: hitta kohde-id och skrapa tills vi får 13 matcher */
async function runJobAuto(debug=false) {
  const key = 'auto';
  if (!cache[key]) cache[key] = {};
  if (cache[key].inProgress) return;

  cache[key].inProgress = true;
  cache[key].lastError = null;
  cache[key].lastDebug = null;

  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    locale: 'sv-SE',
    javaScriptEnabled: true,
    extraHTTPHeaders: { 'Accept-Language': 'sv-SE,sv;q=0.9,fi;q=0.8,en;q=0.7' }
  });

  try {
    const ids = await discoverKohdeIds(context); // nyast först
    if (!ids.length) {
      cache[key].inProgress = false;
      cache[key].lastError = 'Hittade inga kohde-id på vakio-sidorna';
      await browser.close();
      return { ok: false, error: 'No kohde ids found' };
    }

    // prova i tur och ordning tills vi hittar en med 13 matcher
    for (const id of ids) {
      const r = await runJobForKohde(id, debug);
      if (r?.ok) {
        // kopiera även till auto-nyckeln
        cache[key] = {
          ...cache['auto'],
          matches: cache[id].matches,
          endpoint: cache[id].endpoint,
          url: cache[id].url,
          kohde: id,
          updatedAt: cache[id].updatedAt,
          inProgress: false,
          lastError: null,
          lastDebug: debug ? cache[id].lastDebug : null
        };
        await browser.close();
        return { ok: true, kohde: id };
      }
    }

    cache[key].inProgress = false;
    cache[key].lastError = 'Hittade ingen kohde med 13 matcher';
    await browser.close();
    return { ok: false, error: 'No 13-match kohde found' };
  } catch (e) {
    cache[key].inProgress = false;
    cache[key].lastError = String(e?.message || e);
    try { await browser.close(); } catch {}
    return { ok: false, error: String(e?.message || e) };
  }
}

/** ===== ROUTES ===== */

// Hälsa
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'vakio-scraper', ts: Date.now() });
});

// Endast hitta kohde-id (felsökning / manuell koll)
app.get('/api/veikkaus/find', async (req, res) => {
  try {
    const browser = await chromium.launch({ args: LAUNCH_ARGS });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      locale: 'sv-SE',
      javaScriptEnabled: true,
    });
    const ids = await discoverKohdeIds(context);
    await browser.close();
    res.json({ ok: true, ids });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Kicka igång (auto eller explicit kohde)
app.get('/api/veikkaus/kick', async (req, res) => {
  const kohde = typeof req.query.kohde === 'string' ? req.query.kohde.trim() : '';
  const force = String(req.query.force || '') === '1';
  const debug = String(req.query.debug || '') === '1';
  const key = kohde || 'auto';

  if (!cache[key]) cache[key] = {};
  if (force || !cache[key].inProgress) {
    if (kohde) runJobForKohde(kohde, debug).catch(()=>{});
    else runJobAuto(debug).catch(()=>{});
    cache[key].inProgress = true;
  }

  res.json({
    ok: true,
    message: 'Job started (background)',
    mode: kohde ? 'kohde' : 'auto',
    kohde: kohde || null,
    inProgress: true
  });
});

// Hämta senaste (auto eller explicit kohde)
app.get('/api/veikkaus/last', (req, res) => {
  const kohde = typeof req.query.kohde === 'string' ? req.query.kohde.trim() : '';
  const key = kohde || 'auto';
  const item = cache[key];

  if (!item || !item.matches) {
    return res.json({
      ok: false,
      mode: kohde ? 'kohde' : 'auto',
      kohde: item?.kohde || (kohde || null),
      inProgress: !!(item && item.inProgress),
      lastError: item?.lastError || null,
      updatedAt: item?.updatedAt || null,
      debug: item?.lastDebug || null
    });
  }

  res.json({
    ok: true,
    mode: kohde ? 'kohde' : 'auto',
    kohde: item.kohde || (kohde || null),
    inProgress: !!item.inProgress,
    endpoint: item.endpoint,
    url: item.url,
    updatedAt: item.updatedAt,
    matches: item.matches,
    debug: item.lastDebug || null
  });
});

/** Enkel “timer”: försök auto en gång i timmen. 
 * (På Render Free kan dynon sova, men när den är uppe hjälper detta.)
 */
setInterval(() => {
  const hour = new Date().getUTCHours(); // enkel variant (UTC)
  // Kör inte för ofta – men försök ibland
  runJobAuto(false).catch(()=>{});
}, 60 * 60 * 1000); // varje timme

app.listen(PORT, () => {
  console.log(`vakio-scraper listening on :${PORT}`);
});
