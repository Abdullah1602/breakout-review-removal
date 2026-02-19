const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_FILE = path.join(__dirname, "cookies.txt");

// ✅ In-memory job store
const jobs = {};

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
  let lastHeight = 0;
  let unchanged = 0;
  while (true) {
    const newHeight = await page.evaluate(() => {
      const containers = [
        document.querySelector("div[role='main']"),
        document.querySelector(".review-dialog-list"),
        document.querySelector("[jsname='Wye04d']"),
        document.querySelector("[jsname='ScCUV']"),
        document.querySelector("c-wiz"),
        document.documentElement,
      ];
      const container = containers.find(
        (el) => el && el.scrollHeight > window.innerHeight
      ) || document.documentElement;
      container.scrollBy(0, 2000);
      window.scrollBy(0, 2000);
      return Math.max(container.scrollHeight, document.body.scrollHeight);
    });
    await humanDelay(2000, 3500);
    if (newHeight === lastHeight) {
      unchanged++;
      if (unchanged >= 5) break;
    } else {
      unchanged = 0;
    }
    lastHeight = newHeight;
  }
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

// ✅ Core scraper runs in background
async function runScraper(placeId, jobId) {
  const BASE_URL = `https://search.google.com/local/reviews?placeid=${placeId}`;
  console.log(`[Job ${jobId}] Starting scraper for place ID: ${placeId}`);

  let cookieText;
  if (process.env.GOOGLE_COOKIES) {
    cookieText = process.env.GOOGLE_COOKIES;
  } else {
    cookieText = fs.readFileSync(COOKIES_FILE, "utf-8");
  }
  const cookies = parseCookieText(cookieText);
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
    throw new Error("CAPTCHA detected — cookies may be expired.");
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

// ✅ Home — shows API info
app.get("/", (req, res) => {
  res.json({
    status: "✅ Scraper API is running",
    how_to_use: [
      "Step 1: POST or GET /scrape?placeid=YOUR_PLACE_ID — starts scraping, returns a job_id immediately",
      "Step 2: GET /result/:job_id — poll this every 10 seconds until status is 'done'",
    ],
    example_scrape: "/scrape?placeid=ChIJH8hMgj-7PIgRvtZx_hoMcuc",
    example_result: "/result/YOUR_JOB_ID",
  });
});

// ✅ Start scrape — returns job ID immediately (no timeout!)
app.get("/scrape", async (req, res) => {
  const placeId = req.query.placeid;

  if (!placeId) {
    return res.status(400).json({
      error: "Missing placeid parameter",
      usage: "GET /scrape?placeid=YOUR_PLACE_ID",
    });
  }

  // Generate unique job ID
  const jobId = crypto.randomBytes(8).toString("hex");

  // Store job as pending
  jobs[jobId] = { status: "pending", place_id: placeId, started_at: new Date().toISOString() };

  // ✅ Return job ID immediately — no waiting!
  res.json({
    job_id: jobId,
    status: "pending",
    message: "Scraping started! Poll /result/" + jobId + " every 10 seconds for results.",
    result_url: `/result/${jobId}`,
  });

  // Run scraper in background
  runScraper(placeId, jobId)
    .then((result) => {
      jobs[jobId] = { status: "done", ...result };
      console.log(`[Job ${jobId}] ✅ Complete! Found ${result.total_one_star_reviews} reviews.`);
    })
    .catch((err) => {
      jobs[jobId] = { status: "error", error: err.message };
      console.error(`[Job ${jobId}] ❌ Error:`, err.message);
    });
});

// ✅ Poll for results
app.get("/result/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];

  if (!job) {
    return res.status(404).json({ error: "Job not found. It may have expired." });
  }

  res.json(job);
});

app.listen(PORT, () => {
  console.log(`✅ Scraper API running on port ${PORT}`);
  console.log(`Step 1: GET /scrape?placeid=YOUR_PLACE_ID`);
  console.log(`Step 2: GET /result/:job_id`);
});