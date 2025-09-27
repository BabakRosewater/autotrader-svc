import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());

// Wait on link anchors; they’re the most stable thing across layouts
const LINK_SEL = 'a[href*="/cars-for-sale/vehicle"]';
// Use the generic endpoint; zip/radius drive the results
const BASE = "https://www.autotrader.com/cars-for-sale/all-cars";

// ---------- helpers ----------
function buildUrl({ zip, radius, priceMax, drive }) {
  const u = new URL(BASE);
  if (zip) u.searchParams.set("zip", zip);
  if (radius) u.searchParams.set("searchRadius", radius);
  if (priceMax) u.searchParams.set("priceRange", `0-${priceMax}`);
  if (drive) u.searchParams.set("driveGroup", drive); // AWD4WD / FWD / RWD
  return u.toString();
}

function cleanNum(s) {
  if (!s) return null;
  const t = s.replace(/[$,]|mi\.?|miles?/gi, "").trim();
  const m = t.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

async function clickIfExists(page, text) {
  const b = await page.$(`button:has-text("${text}")`);
  if (b) {
    await b.click().catch(() => {});
    await page.waitForTimeout(600);
    return true;
  }
  return false;
}

async function acceptCookies(page) {
  for (const t of ["Accept All", "Accept all", "I Agree", "Got it", "Accept"]) {
    if (await clickIfExists(page, t)) break;
  }
}

async function pollForLinks(page, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const n = (await page.$$(LINK_SEL)).length;
    if (n > 0) return true;
    // nudge lazy load
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await page.waitForTimeout(900);
  }
  return false;
}

async function extractFromLink(page, aHandle, sourceUrl) {
  // find the nearest “card” root
  const root = await aHandle.evaluateHandle((el) => {
    return (
      el.closest("article") ||
      el.closest('[data-cmp*="inventory"]') ||
      el.closest("li") ||
      el.parentElement
    );
  });

  async function pickText(sel) {
    const el = await root.asElement().$(sel);
    return el ? (await el.textContent())?.trim() : null;
  }

  // fields (defensively try several selectors)
  const title =
    (await pickText('[data-cmp="inventoryListingTitle"]')) ||
    (await pickText("h3")) ||
    (await pickText("h2")) ||
    (await pickText('[data-cmp*="title"]'));

  const price_raw =
    (await pickText('[data-cmp="pricing"] :text("$")')) ||
    (await pickText(':text("$")'));

  const mileage_raw =
    (await pickText(':text(" mi"), :text("mi.)"), :text("miles")')) ||
    (await pickText('[data-cmp*="mileage"]'));

  const dealer =
    (await pickText('[data-cmp="dealerName"]')) ||
    (await pickText('[data-cmp="seller-name"]')) ||
    (await pickText(".dealer-name"));

  const deal_badge = await pickText(
    ':text("Great Price"), :text("Good Price"), :text("Fair Price")'
  );

  // anchor href
  let link = await aHandle.getAttribute("href");
  if (link?.startsWith("/")) link = "https://www.autotrader.com" + link;

  // parse year/make/model/trim from title if present
  let year = null,
    make = null,
    model = null,
    trim = null;
  if (title) {
    const parts = title.split(/\s+/);
    if (/^\d{4}$/.test(parts[0])) {
      year = parts[0];
      make = parts[1] || null;
      model = parts[2] || null;
      trim = parts.slice(3).join(" ") || null;
    }
  }

  return {
    source_url: sourceUrl,
    title,
    year,
    make,
    model,
    trim,
    price_raw,
    price_num: cleanNum(price_raw),
    mileage_raw,
    mileage_num: cleanNum(mileage_raw),
    dealer,
    deal_badge,
    sponsored: false, // if we don’t find a badge we treat it as organic
    link,
  };
}

async function scrape(url, cap = 800) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const ctx = await browser.newContext({
    // make it look like a normal US desktop
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1366, height: 1800 },
    locale: "en-US",
  });
  const page = await ctx.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptCookies(page);
  await page.waitForLoadState("networkidle").catch(() => {});

  // Wait for at least one vehicle link to attach
  const firstLink = await page
    .waitForSelector(LINK_SEL, { state: "attached", timeout: 45000 })
    .catch(() => null);

  if (!firstLink) {
    const ok = await pollForLinks(page, 60);
    if (!ok) throw new Error("No vehicle links attached after scrolling.");
  }

  // Load more results (scrolling is enough; “See More” isn’t always present)
  for (let i = 0; i < 50; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700 + Math.floor(Math.random() * 400));
    const count = (await page.$$(LINK_SEL)).length;
    if (count >= cap) break;
  }

  const links = await page.$$(LINK_SEL);
  const out = [];
  for (const a of links) {
    const row = await extractFromLink(page, a, url);
    out.push(row);
    if (out.length >= cap) break;
  }

  await browser.close();
  return out;
}

app.get("/search", async (req, res) => {
  try {
    const { zip = "59901", radius = "10", priceMax, drive } = req.query;
    const url = buildUrl({ zip, radius, priceMax, drive });
    const rows = await scrape(url, 800);
    res.json({ ok: true, rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Friendly hint on /
app.get("/", (_req, res) => {
  res.status(200).send('OK. Try <code>/search?zip=59901&radius=10</code>');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API listening on " + port));
