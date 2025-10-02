// server.js
// Körs i Render (Docker) med Playwright-basen mcr.microsoft.com/playwright:v1.55.1-jammy
// ES Modules – kräver "type": "module" i package.json

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // säker fallback, används sparsamt
import { chromium } from "playwright";

// ---------- Grund-setup ----------
const app = express();
app.use(cors());
app.use(express.json());

// Snabb health – svarar direkt så Render inte ger 502
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Root – också lättvikt
app.get("/", (req, res) => {
  res
    .status(200)
    .send("vakio-scraper is running • use /api/veikkaus/find, /kick, /last");
});

// ---------- Server startar först, tung init efteråt ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`vakio-scraper listening on :${PORT}`);
});

// ---------- Playwright: starta efter listen ----------
let browser = null;
async function ensureBrowser() {
  if (browser) return browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
    });
    return browser;
  } catch (e) {
    console.error("Playwright init failed:", e);
    throw e;
  }
}

// ---------- Jobb & cache i minnet ----------
/**
 * resultsCache: Map<string, { ok:boolean, mode:'auto'|'kohde', kohde?:string, inProgress:boolean, lastError?:string|null,
 *   updatedAt?:string|null, matches?:any[], endpoint?:string, debug?:any }>
 * Nyckel: 'auto' eller ett kohde-id (t.ex. 'a_100516')
 */
const resultsCache = new Map();

/**
 * runningJobs: Set<string> – samma nycklar. Hindrar dubbla jobb för samma kohde/auto.
 */
const runningJobs = new Set();

// Hjälp: skriv standardstatus i cachen
function setStatus(key, patch) {
  const prev = resultsCache.get(key) || {
    ok: false,
    mode: key === "auto" ? "auto" : "kohde",
    kohde: key === "auto" ? undefined : key,
    inProgress: false,
    lastError: null,
    updatedAt: null,
    matches: [],
    endpoint: undefined,
    debug: null,
  };
  const next = { ...prev, ...patch };
  resultsCache.set(key, next);
  return next;
}

// ---------- Hjälpfunktioner för scraping ----------
async function autoFindLatestKohde(page, timeoutMs = 15000) {
  // Försök att hitta en ny “vakio?kohde=...” på startsidan
  const url = "https://www.veikkaus.fi/sv/vedonlyonti/vakio";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

  // Små anti-bot tweaks (gör inget om de misslyckas)
  try {
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      } catch {}
    });
  } catch {}

  // plocka alla länkar som innehåller “vakio?kohde=”
  const kohdes = await page.$$eval('a[href*="vakio?kohde="]', (as) =>
    Array.from(as)
      .map((a) => a.getAttribute("href"))
      .filter(Boolean)
      .map((h) => {
        try {
          const u = new URL(h, "https://www.veikkaus.fi");
          return u.searchParams.get("kohde");
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  if (kohdes && kohdes.length > 0) {
    // Ta första – i praktiken brukar “senaste” vara först
    return kohdes[0];
  }
  return null;
}

// Enkel funktion som försöker extrahera matcher, streck och odds från kohde-sidan.
// OBS: Markup kan ändras – då justerar vi selektorer.
async function scrapeKohde(page, kohde, timeoutMs = 20000) {
  const url = `https://www.veikkaus.fi/sv/vedonlyonti/vakio?kohde=${encodeURIComponent(
    kohde
  )}`;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

  // Vänta lite extra på dynamiskt innehåll
  try {
    await page.waitForTimeout(1000);
  } catch {}

  // För felsökning: ta en snabb HTML-bit
  let sampleHTML = "";
  try {
    sampleHTML = await page.evaluate(
      () => document.documentElement.innerHTML.slice(0, 1000)
    );
  } catch {}

  // FÖRSÖK 1: Letar efter en global json i window (ibland SPA sätter data)
  try {
    const anyJSON = await page.evaluate(() => {
      const scripts = Array.from(
        document.querySelectorAll("script[type='application/json']")
      );
      return scripts.map((s) => s.textContent?.slice(0, 500)).filter(Boolean);
    });
    if (anyJSON && anyJSON.length > 0) {
      // Vi har åtminstone hittat något JSON – men vi vet inte formatet.
      // (Lämna i debug för felsökning)
      return {
        ok: false,
        error: "Behöver justera parsern för JSON-formatet",
        debug: { jsonSnippets: anyJSON.slice(0, 3) },
        matches: [],
      };
    }
  } catch {}

  // FÖRSÖK 2: Läs text på sidan och leta efter 13 matcher (en reserv)
  // OBS: Detta är en "fallback". Den ger oss inte streck/odds exakt – men visar strukturen.
  let text = "";
  try {
    text = await page.evaluate(() => document.body.innerText || "");
  } catch {}

  // Naiv regex för matchrader, vi försöker hitta 13 par-rader.
  // Vi parar ihop ordpar “LagA – LagB” (väldigt förenklat, kan kräva justering för finska/svenska ligor).
  const lineRegex = /([A-Za-zÅÄÖåäö0-9\.\-\/\s]+)\s+[–-]\s+([A-Za-zÅÄÖåäö0-9\.\-\/\s]+)/g;
  const pairs = [];
  let m;
  while ((m = lineRegex.exec(text)) && pairs.length < 20) {
    const home = (m[1] || "").trim().replace(/\s{2,}/g, " ");
    const away = (m[2] || "").trim().replace(/\s{2,}/g, " ");
    if (home && away && home.length < 40 && away.length < 40) {
      pairs.push({ home, away });
    }
  }

  // Om vi hittar minst 10 par så gissar vi att vi är på rätt spår
  if (pairs.length >= 10) {
    const take = pairs.slice(0, 13);
    // Dummy procent (tills vi bygger exakt parsning för streck/odds):
    const matches = take.map((p, idx) => ({
      index: idx + 1,
      home: p.home,
      away: p.away,
      percent: { "1": 45, X: 25, "2": 30 },
      odds: undefined,
      oddsProbPct: undefined,
      deviation: undefined,
    }));
    return {
      ok: true,
      matches,
      endpoint: "html-fallback",
      debug: { sampleHTML },
    };
  }

  // Inget funnet -> returnera bra fel för frontend
  return {
    ok: false,
    error: "No 13-match draw found (behöver uppdatera selektorer/parsning)",
    debug: { sampleHTML },
    matches: [],
  };
}

// Ett helt jobb (auto eller kohde) i bakgrunden
async function runJob(key, mode, givenKohde = null) {
  if (runningJobs.has(key)) return; // redan igång
  runningJobs.add(key);
  setStatus(key, { inProgress: true, lastError: null });

  let context = null;
  let page = null;

  try {
    const b = await ensureBrowser();
    context = await b.newContext({
      viewport: { width: 1200, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
    });
    page = await context.newPage();

    let kohde = givenKohde;

    if (mode === "auto") {
      kohde = await autoFindLatestKohde(page).catch(() => null);
      if (!kohde) {
        setStatus(key, {
          ok: false,
          inProgress: false,
          lastError: "Kunde inte hitta kohde automatiskt",
          updatedAt: new Date().toISOString(),
          debug: { phase: "auto-find" },
        });
        return;
      }
    }

    const res = await scrapeKohde(page, kohde);
    if (res.ok && Array.isArray(res.matches) && res.matches.length > 0) {
      setStatus(key, {
        ok: true,
        inProgress: false,
        lastError: null,
        updatedAt: new Date().toISOString(),
        kohde,
        matches: res.matches,
        endpoint: res.endpoint || "html",
        debug: res.debug || null,
      });
    } else {
      setStatus(key, {
        ok: false,
        inProgress: false,
        lastError: res.error || "Okänt fel i parsning",
        updatedAt: new Date().toISOString(),
        kohde,
        matches: [],
        endpoint: res.endpoint || "html",
        debug: res.debug || null,
      });
    }
  } catch (e) {
    setStatus(key, {
      ok: false,
      inProgress: false,
      lastError: String(e?.message || e),
      updatedAt: new Date().toISOString(),
      matches: [],
      endpoint: "exception",
    });
  } finally {
    try {
      if (page) await page.close();
      if (context) await context.close();
    } catch {}
    runningJobs.delete(key);
  }
}

// ---------- API-routes för frontenden ----------

// 1) Hitta senaste kohde (AUTO)
app.get("/api/veikkaus/find", async (req, res) => {
  let context = null;
  let page = null;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({
      viewport: { width: 1200, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
    });
    page = await context.newPage();

    const kohde = await autoFindLatestKohde(page);
    if (kohde) {
      res.json({ ok: true, kohde });
    } else {
      res.status(404).json({ ok: false, error: "Ingen kohde hittad" });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    try {
      if (page) await page.close();
      if (context) await context.close();
    } catch {}
  }
});

// 2) Starta jobb (AUTO eller KOHDE). Exempel: /api/veikkaus/kick?kohde=a_100522&force=1
app.get("/api/veikkaus/kick", async (req, res) => {
  const kohde = (req.query.kohde || "").toString().trim();
  const force = req.query.force === "1";
  const key = kohde ? kohde : "auto";
  const mode = kohde ? "kohde" : "auto";

  const existing = resultsCache.get(key);
  if (!force && existing && existing.ok && existing.matches?.length) {
    return res.json({
      ok: true,
      message: "Redan klart – återanvänder cache",
      mode,
      kohde: existing.kohde || (key === "auto" ? undefined : key),
      inProgress: false,
    });
  }

  // Om ett jobb redan kör – svara bara att det är igång
  if (runningJobs.has(key)) {
    return res.json({
      ok: true,
      message: "Jobb kör redan",
      mode,
      kohde: kohde || undefined,
      inProgress: true,
    });
  }

  // Starta i bakgrunden
  setImmediate(() => runJob(key, mode, kohde || null));
  res.json({
    ok: true,
    message: "Jobb startat (bakgrund)",
    mode,
    kohde: kohde || undefined,
    inProgress: true,
  });
});

// 3) Läs status/resultat. Exempel: /api/veikkaus/last (AUTO) eller /api/veikkaus/last?kohde=a_100522
app.get("/api/veikkaus/last", async (req, res) => {
  const kohde = (req.query.kohde || "").toString().trim();
  const key = kohde ? kohde : "auto";
  const data = resultsCache.get(key);
  if (!data) {
    return res.json({
      ok: false,
      mode: kohde ? "kohde" : "auto",
      kohde: kohde || undefined,
      inProgress: runningJobs.has(key),
      lastError: null,
      updatedAt: null,
      debug: null,
    });
  }
  res.json(data);
});

// ---------- Graceful shutdown ----------
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing...");
  try {
    if (browser) await browser.close();
  } catch {}
  process.exit(0);
});
