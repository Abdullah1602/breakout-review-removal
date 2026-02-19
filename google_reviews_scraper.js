const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const COOKIES_FILE = path.join(__dirname, "cookies.txt");

// ✅ Change 1: BASE_URL from environment variable (change anytime in Heroku config vars)
const BASE_URL = process.env.BASE_URL || "https://search.google.com/local/reviews?placeid=ChIJH8hMgj-7PIgRvtZx_hoMcuc";

// ✅ Change 2: parseCookieText accepts raw text (not a file path)
// This allows cookies to come from either env variable OR local file
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

    const [btn] = await page.$x(
      '//*[contains(translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"lowest rating")]'
    );
    if (btn) {
      const text = await btn.evaluate((n) => n.textContent.trim());
      console.log(`XPath found: "${text}"`);
      await btn.click();
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

    if (!blocks.length) {
      blocks = Array.from(document.querySelectorAll("[data-review-id]"));
    }
    if (!blocks.length) {
      blocks = Array.from(document.querySelectorAll("div[jscontroller='e6Mltc']"));
    }

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

(async () => {
  // ✅ Change 3: Load cookies from GOOGLE_COOKIES env variable (Heroku) or local file (local testing)
  console.log("Loading cookies...");
  let cookieText;
  if (process.env.GOOGLE_COOKIES) {
    console.log("Using cookies from environment variable (Heroku)");
    cookieText = process.env.GOOGLE_COOKIES;
  } else {
    console.log("Using cookies from local cookies.txt file");
    cookieText = fs.readFileSync(COOKIES_FILE, "utf-8");
  }
  const cookies = parseCookieText(cookieText);
  console.log(`Loaded ${cookies.length} Google cookies`);

  console.log("Launching browser...");
  const browser = await puppeteer.launch({
    // ✅ Change 4: headless:true for Heroku, extra args required for Linux server
    headless: true,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",   // ✅ Required on Heroku
      "--disable-gpu",              // ✅ Required on Heroku
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
      "--lang=en-US,en",
    ],
  });

  // ✅ Change 5: Close the default blank tab
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

  console.log("Injecting cookies...");
  try {
    await page.setCookie(...cookies);
    console.log("Cookies set");
  } catch (e) {
    console.warn("Some cookies failed:", e.message);
  }

  console.log("Navigating to reviews page...");
  await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await humanDelay(3000, 5000);

  const title = await page.title();
  console.log(`Page title: "${title}"`);

  if (/verify|unusual traffic|captcha/i.test(title)) {
    console.error("CAPTCHA detected — cookies may be expired.");
    await browser.close();
    process.exit(1);
  }

  console.log("Waiting for reviews to appear...");
  await waitForReviews(page);

  console.log("Clicking 'Lowest rating' sort...");
  const sorted = await clickLowestRatingFilter(page);
  if (!sorted) {
    console.warn("Could not apply filter. Will filter 1-star manually.");
  }

  console.log("Scrolling to load all reviews...");
  await scrollToBottom(page);

  console.log("Expanding all 'More' buttons for full review text...");
  await expandAllMoreButtons(page);

  await sleep(1500);

  console.log("Extracting reviews...");
  const reviews = await extractReviews(page);

  const oneStarReviews = reviews.filter((r) => r.rating_stars === 1);
  console.log(`Found ${oneStarReviews.length} one-star reviews`);

  oneStarReviews.sort((a, b) => parseDate(b.review_date) - parseDate(a.review_date));

  const output = {
    scraped_at: new Date().toISOString(),
    place_id: "ChIJH8hMgj-7PIgRvtZx_hoMcuc",
    filter: "1-star reviews only",
    sort: "newest first",
    total_one_star_reviews: oneStarReviews.length,
    reviews: oneStarReviews,
  };

  // ✅ Change 6: Log the output to console as well (Heroku logs are your only output)
  console.log("Extracted reviews JSON:");
  console.log(JSON.stringify(output, null, 2));

  // Also save locally if running on local machine
  if (!process.env.GOOGLE_COOKIES) {
    fs.writeFileSync("google_reviews_1star.json", JSON.stringify(output, null, 2), "utf-8");
    console.log("Saved to google_reviews_1star.json");
  }

  await browser.close();
})();