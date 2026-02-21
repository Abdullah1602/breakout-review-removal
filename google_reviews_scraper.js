
try { require("dotenv").config(); } catch (_) {}

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_FILE = path.join(__dirname, "cookies.txt");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;


const jobs = {};

let cookieOverride = null;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function parseCookieText(text) {
  const cookies = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, , path, secure, expires, name, ...valueParts] = parts;
    const value = valueParts.join("\t");
    if (!domain.includes("google.com")) continue;
    cookies.push({
      name: name.trim(),
      value: value.trim(),
      domain: domain.trim(),
      path: path.trim(),
      expires: parseInt(expires, 10) || -1,
      httpOnly: false,
      secure: secure === "TRUE",
      sameSite: "Lax",
    });
  }
  return cookies;
}

function loadCookies() {
  if (cookieOverride) {
    console.log("Using cookies from web form update");
    return parseCookieText(cookieOverride);
  }
  if (process.env.GOOGLE_COOKIES) {
    console.log("Using cookies from GOOGLE_COOKIES env var (Heroku Config Vars)");
    return parseCookieText(process.env.GOOGLE_COOKIES);
  }
  console.log("Using cookies from local cookies.txt file");
  return parseCookieText(fs.readFileSync(COOKIES_FILE, "utf-8"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = (min = 800, max = 2000) =>
  sleep(Math.floor(Math.random() * (max - min) + min));

async function waitForReviews(page, timeout = 25000) {
  try {
    await page.waitForSelector(".Vpc5Fe, .OA1nbd, [data-review-id]", { timeout });
    await sleep(2500);
    console.log("Review elements detected");
  } catch {
    console.warn("No review elements found within timeout, proceeding anyway");
  }
}

async function clickLowestRatingFilter(page) {
  try {
    const allClickable = await page.$$("g-chip, button, [role='tab'], [role='radio'], [role='button']");
    for (const el of allClickable) {
      const text = await el.evaluate((n) => (n.innerText || n.textContent || "").trim());
      if (/lowest.?rating/i.test(text)) {
        console.log(`Found sort chip: "${text}"`);
        await el.click();
        await page.waitForNetworkIdle({ timeout: 12000 }).catch(() => {});
        await sleep(3000);
        await waitForReviews(page);
        return true;
      }
    }

    const clicked = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll("*"));
      for (const el of allEls) {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (text === "lowest rating" && el.children.length === 0) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      console.log("Clicked lowest rating via evaluate");
      await page.waitForNetworkIdle({ timeout: 12000 }).catch(() => {});
      await sleep(3000);
      await waitForReviews(page);
      return true;
    }

    console.warn("Lowest Rating button not found");
    return false;
  } catch (e) {
    console.warn("Filter click error:", e.message);
    return false;
  }
}

async function scrollToBottom(page) {
  let lastCount = 0;
  let unchanged = 0;

  while (true) {
    const newCount = await page.evaluate(() => {
      // Try all known Google review scroll containers
      const selectors = [
        "div[jsname='Wye04d']",
        "div[jsname='ScCUV']",
        ".review-dialog-list",
        "div[role='main'] > div > div",
        "c-wiz",
      ];

      let scrolled = false;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight + 100) {
          el.scrollBy(0, 3000);
          scrolled = true;
          break;
        }
      }

      // Also scroll any div that is tall and scrollable
      if (!scrolled) {
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const div of allDivs) {
          if (div.scrollHeight > div.clientHeight + 500 && div.clientHeight > 300) {
            div.scrollBy(0, 3000);
            break;
          }
        }
      }

      // Also scroll the page itself
      window.scrollBy(0, 3000);

      // Return current number of review elements as progress indicator
      return document.querySelectorAll(".Vpc5Fe, [data-review-id]").length;
    });

    await humanDelay(2500, 4000);

    console.log(`Scrolling... reviews visible so far: ${newCount}`);

    if (newCount === lastCount) {
      unchanged++;
      if (unchanged >= 5) break;
    } else {
      unchanged = 0;
    }
    lastCount = newCount;
  }

  console.log(`Scroll complete. Total visible reviews: ${lastCount}`);
}

async function expandAllMoreButtons(page) {
  let totalExpanded = 0;
  while (true) {
    const moreLinks = await page.$$(
      'a.MtCSLb[jsaction="KoToPc"], a[aria-label*="Read more"], a[jsaction="KoToPc"]'
    );
    if (moreLinks.length === 0) break;
    let clickedThisRound = 0;
    for (const link of moreLinks) {
      try {
        await link.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await sleep(200);
        await link.click();
        await sleep(400);
        clickedThisRound++;
        totalExpanded++;
      } catch (_) {}
    }
    if (clickedThisRound === 0) break;
    if (totalExpanded > 2000) break;
    await sleep(300);
  }
  console.log(`Expanded ${totalExpanded} "More" buttons`);
}

async function extractReviews(page) {
  return page.evaluate(() => {
    const reviews = [];
    let blocks = [];
    const nameDivs = Array.from(document.querySelectorAll(".Vpc5Fe"));
    const seen = new Set();
    nameDivs.forEach((nameDiv) => {
      let node = nameDiv;
      for (let i = 0; i < 8; i++) {
        node = node.parentElement;
        if (!node) break;
        if (
          node.querySelector(".Vpc5Fe") &&
          (node.querySelector(".OA1nbd") || node.querySelector(".y3Ibjb"))
        ) {
          if (!seen.has(node)) {
            seen.add(node);
            blocks.push(node);
          }
          break;
        }
      }
    });
    if (!blocks.length) blocks = Array.from(document.querySelectorAll("[data-review-id]"));
    if (!blocks.length) blocks = Array.from(document.querySelectorAll("div[jscontroller='e6Mltc']"));

    blocks.forEach((block) => {
      const name = block.querySelector(".Vpc5Fe")?.innerText?.trim() || "";
      const ratingEl =
        block.querySelector('.dHX2k[role="img"]') ||
        block.querySelector('[role="img"][aria-label*="out of 5"]') ||
        block.querySelector('[role="img"][aria-label*="Rated"]') ||
        block.querySelector('[role="img"][aria-label*="star"]') ||
        block.querySelector('span[aria-label*="star"]');
      const ratingRaw = ratingEl?.getAttribute("aria-label") || "";
      const ratingMatch = ratingRaw.match(/(\d+(\.\d+)?)/);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
      const textContainer = block.querySelector(".OA1nbd");
      let text = "";
      if (textContainer) {
        const clone = textContainer.cloneNode(true);
        clone.querySelectorAll("a.MtCSLb, a[jsaction='KoToPc']").forEach((a) => a.remove());
        text = clone.innerText?.trim() || "";
        text = text.replace(/\s*[…\.]{0,3}\s*More\s*$/i, "").trim();
      }
      const date = block.querySelector(".y3Ibjb")?.innerText?.trim() || "";
      const images = [];
      block.querySelectorAll("img").forEach((img) => {
        const src = img.src || img.getAttribute("src") || "";
        if (src && src.includes("googleusercontent")) {
          images.push(src.replace(/=s\d+(-[^&]*)?$/, "=s1600-p-k-rw"));
        }
      });
      if (name || text) {
        reviews.push({
          reviewer_name: name,
          rating_raw: ratingRaw,
          rating_stars: rating,
          review_text: text,
          review_date: date,
          images: [...new Set(images)],
        });
      }
    });
    return reviews;
  });
}

function parseDate(str) {
  if (!str) return 0;
  const d = new Date(str);
  if (!isNaN(d)) return d.getTime();
  const ago = str.match(/(\d+)\s+(day|week|month|year)/i);
  if (ago) {
    const n = parseInt(ago[1]);
    const unit = ago[2].toLowerCase();
    const now = Date.now();
    const map = { day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
    return now - n * (map[unit] || 0);
  }
  return 0;
}

async function runScraper(placeId, jobId) {
  const BASE_URL = `https://search.google.com/local/reviews?placeid=${placeId}`;
  console.log(`[Job ${jobId}] Starting scraper for place ID: ${placeId}`);

  const cookies = loadCookies();
  console.log(`[Job ${jobId}] Loaded ${cookies.length} Google cookies`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
      "--lang=en-US,en",
    ],
  });

  const existingPages = await browser.pages();
  if (existingPages.length > 0) await existingPages[0].close();

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  try {
    await page.setCookie(...cookies);
  } catch (e) {
    console.warn(`[Job ${jobId}] Some cookies failed:`, e.message);
  }

  await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await humanDelay(3000, 5000);

  const title = await page.title();
  console.log(`[Job ${jobId}] Page title: "${title}"`);

  if (/verify|unusual traffic|captcha/i.test(title)) {
    await browser.close();
    throw new Error("CAPTCHA detected — cookies may be expired. Update at /update-cookies");
  }

  await waitForReviews(page);
  await clickLowestRatingFilter(page);
  await scrollToBottom(page);
  await expandAllMoreButtons(page);
  await sleep(1500);

  const reviews = await extractReviews(page);
  const oneStarReviews = reviews.filter((r) => r.rating_stars === 1);
  oneStarReviews.sort((a, b) => parseDate(b.review_date) - parseDate(a.review_date));

  await browser.close();

  return {
    scraped_at: new Date().toISOString(),
    place_id: placeId,
    filter: "1-star reviews only",
    sort: "newest first",
    total_one_star_reviews: oneStarReviews.length,
    reviews: oneStarReviews,
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "Scraper API is running",
    endpoints: {
      scrape: "GET /scrape?placeid=YOUR_PLACE_ID",
      result: "GET /result/:job_id",
      update_cookies: "GET /update-cookies (admin only)",
    },
    example: "/scrape?placeid=ChIJH8hMgj-7PIgRvtZx_hoMcuc",
  });
});

app.get("/scrape", async (req, res) => {
  const placeId = req.query.placeid;
  if (!placeId) {
    return res.status(400).json({
      error: "Missing placeid parameter",
      usage: "GET /scrape?placeid=YOUR_PLACE_ID",
    });
  }

  const jobId = crypto.randomBytes(8).toString("hex");
  jobs[jobId] = { status: "pending", place_id: placeId, started_at: new Date().toISOString() };

  res.json({
    job_id: jobId,
    status: "pending",
    message: "Scraping started! Poll /result/" + jobId + " every 10 seconds.",
    result_url: `/result/${jobId}`,
  });

  runScraper(placeId, jobId)
    .then((result) => {
      jobs[jobId] = { status: "done", ...result };
      console.log(`[Job ${jobId}] Complete! Found ${result.total_one_star_reviews} reviews.`);
    })
    .catch((err) => {
      jobs[jobId] = { status: "error", error: err.message };
      console.error(`[Job ${jobId}] Error:`, err.message);
    });
});

app.get("/result/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json(job);
});

app.get("/update-cookies", (req, res) => {
  const currentCookies = loadCookies();
  const source = cookieOverride
    ? "web form (memory)"
    : process.env.GOOGLE_COOKIES
    ? "Heroku Config Var (GOOGLE_COOKIES)"
    : "cookies.txt file (GitHub)";

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Update Google Cookies</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 32px; max-width: 620px; width: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
    h1 { font-size: 22px; color: #333; margin-bottom: 6px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .status { background: #e8f5e9; border: 1px solid #66bb6a; color: #2e7d32; padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
    label { display: block; font-size: 14px; font-weight: 600; color: #444; margin-bottom: 6px; margin-top: 16px; }
    input[type=password] { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; outline: none; }
    input[type=password]:focus { border-color: #4285F4; }
    textarea { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 12px; font-family: monospace; height: 200px; resize: vertical; outline: none; margin-top: 6px; }
    textarea:focus { border-color: #4285F4; }
    button { width: 100%; padding: 14px; background: #4285F4; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 20px; }
    button:hover { background: #3367d6; }
    .steps { background: #f8f9fa; border-radius: 8px; padding: 16px; margin-bottom: 20px; font-size: 13px; color: #555; line-height: 2; }
    .steps strong { color: #333; }
    a { color: #4285F4; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Update Google Cookies</h1>
    <p class="subtitle">Update cookies when scraping stops working</p>

    <div class="status">
      Currently active: <strong>${currentCookies.length} Google cookies</strong><br>
      Source: <strong>${source}</strong>
    </div>

    <div class="steps">
      <strong>How to get fresh cookies:</strong><br>
      1. Open Chrome → go to <a href="https://google.com" target="_blank">google.com</a> — make sure you're logged in<br>
      2. Install <strong>Cookie-Editor</strong> Chrome extension<br>
      3. Click extension icon → <strong>Export</strong> → select <strong>Netscape</strong> format<br>
      4. Copy all the text and paste it below
    </div>

    <form method="POST" action="/update-cookies">
      <label>Admin Password</label>
      <input type="password" name="password" placeholder="Enter admin password" required />

      <label>Paste New Cookies (Netscape format)</label>
      <textarea name="cookies" placeholder="# Netscape HTTP Cookie File&#10;.google.com	TRUE	/	TRUE	..."></textarea>

      <button type="submit">Update Cookies Now</button>
    </form>
  </div>
</body>
</html>
  `);
});

app.post("/update-cookies", (req, res) => {
  const { password, cookies } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:red">Wrong password</h2>
        <a href="/update-cookies">← Try again</a>
      </body></html>
    `);
  }

  if (!cookies || cookies.trim().length < 50) {
    return res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:red">No cookies provided</h2>
        <a href="/update-cookies">← Try again</a>
      </body></html>
    `);
  }

  const parsed = parseCookieText(cookies);

  if (parsed.length === 0) {
    return res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:red">No valid Google cookies found</h2>
        <p>Make sure you exported in Netscape format and are logged into Google.</p>
        <a href="/update-cookies">← Try again</a>
      </body></html>
    `);
  }

  cookieOverride = cookies;
  console.log(`Cookies updated via web form! ${parsed.length} Google cookies now active.`);

  res.send(`
    <html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2 style="color:green">Cookies updated successfully!</h2>
      <p style="margin:12px 0;color:#555">${parsed.length} Google cookies are now active.</p>
      <p style="color:#f57c00;font-size:13px;margin-top:12px">
        These cookies are in memory only.<br>
        For permanent storage: copy the cookie text into<br>
        <strong>Heroku → Settings → Config Vars → GOOGLE_COOKIES</strong>
      </p>
      <br>
      <a href="/" style="color:#4285F4">← Back to API</a>
    </body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`Scraper API running on port ${PORT}`);
  console.log(`Step 1: GET /scrape?placeid=YOUR_PLACE_ID`);
  console.log(`Step 2: GET /result/:job_id`);
  console.log(`Admin:  GET /update-cookies (password: ${ADMIN_PASSWORD})`);
});