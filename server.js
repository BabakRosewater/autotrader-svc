import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());

const CARD_SEL = '[data-cmp="inventory-listing"], article[data-cmp*="inventory"], article:has([data-cmp="inventoryListingTitle"])';
const BASE = "https://www.autotrader.com/cars-for-sale/kalispell-mt";

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

async function extractCard(card, sourceUrl) {
  const getText = async (sel) => {
    const el = await card.$(sel);
    return el ? (await el.textContent())?.trim() : null;
  };

  const sponsored = !!(await card.$(':text("Sponsored"), :text("Sponsored by")'));
  const title = (await getText('[data-cmp="inventoryListingTitle"]')) || (await getText("h3")) || (await getText("h2"));
  const price_raw = await getText('[data-cmp="pricing"] :text("$"), :text("$")');
  const mileage_raw = (await getText(':text("mi.")')) || (await getText(':text(" miles")'));
  const dealer = (await getText('[data-cmp="dealerName"]')) || (await getText('[data-cmp="seller-name"]')) || (await getText(".dealer-name"));
  const deal_badge = await getText(':text("Great Price"), :text("Good Price"), :text("Fair Price")');

  let link = null;
  const a = await card.$('a[href*="/cars-for-sale/vehicle"]');
  if (a) {
    link = await a.getAttribute("href");
    if (link?.startsWith("/")) link = "https://www.autotrader.com" + link;
  }

  let year=null, make=null, model=null, trim=null;
  if (title) {
    const parts = title.split(/\s+/);
    if (/^\d{4}$/.test(parts[0])) {
      year = parts[0]; make = parts[1] || null; model = parts[2] || null; trim = parts.slice(3).join(" ") || null;
    }
  }

  return {
    source_url: sourceUrl, title, year, make, model, trim,
    price_raw, price_num: cleanNum(price_raw),
    mileage_raw, mileage_num: cleanNum(mileage_raw),
    dealer, deal_badge, sponsored, link
  };
}

async function scrape(url, cap = 800) {
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1366, height: 1800 }
  });
  const page = await ctx.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(CARD_SEL, { timeout: 20000 });

  for (let i = 0; i < 30; i++) {
    const btn = await page.$('button:has-text("See More Results")');
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(900 + Math.floor(Math.random() * 400));
    } else {
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await page.waitForTimeout(900);
    }
    const count = (await page.$$(CARD_SEL)).length;
    if (count >= cap) break;
  }

  const cards = await page.$$(CARD_SEL);
  const out = [];
  for (const c of cards) {
    const row = await extractCard(c, url);
    if (!row.sponsored) out.push(row);
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API listening on " + port));
