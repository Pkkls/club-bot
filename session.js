/**
 * Persistent session management — saves/restores cookies so Tyler
 * never has to go through Google OAuth more than once.
 * Cookies stored in GitHub Actions cache via cookies_cxfan.json
 */

const fs   = require("fs");
const path = require("path");

const COOKIES_FILE = path.join(process.cwd(), "cookies_cxfan.json");
const BASE         = "https://club.com";

function saveCookies(cookies) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
}

function loadCookies() {
  try {
    if (fs.existsSync(COOKIES_FILE)) return JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
  } catch {}
  return null;
}

async function restoreSession(page) {
  const cookies = loadCookies();
  if (!cookies?.length) return false;
  await page.setCookie(...cookies);
  return true;
}

async function checkLoggedIn() {
  const token = loadCookies()?.find(c => c.name === "chatAuthToken")?.value;
  if (!token) { console.log("[session] no chatAuthToken found"); return false; }
  return new Promise((resolve) => {
    const req = require("https").request(
      {
        hostname: "club.com",
        path: "/api/auth/me",
        method: "GET",
        headers: {
          "Cookie": `chatAuthToken=${token}`,
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
      (res) => {
        let data = "";
        res.on("data", d => data += d);
        res.on("end", () => {
          const ok = res.statusCode === 200;
          try {
            const j = JSON.parse(data);
            console.log(`[session] auth check → HTTP ${res.statusCode} | user: ${j.id?.slice(0,8) || "?"}`);
          } catch {
            console.log(`[session] auth check → HTTP ${res.statusCode}`);
          }
          resolve(ok);
        });
      }
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function login(page, EMAIL, PASSWORD) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand  = (a, b) => Math.floor(Math.random() * (b - a) + a);

  console.log("[session] navigating to club.com...");
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(rand(2000, 3500));

  // Try clicking login button
  try {
    await page.click('button::-p-text(Log in or sign up)');
  } catch {
    const btns = await page.$$("button");
    for (const b of btns) {
      const t = await page.evaluate(el => el.textContent, b);
      if (t?.includes("Log in")) { await b.click(); break; }
    }
  }
  await sleep(rand(1500, 3000));

  // Google button (scaled to 1920x1080)
  await page.mouse.click(Math.floor(594 * 1920 / 1280), Math.floor(317 * 1080 / 720));
  await sleep(rand(2500, 4000));

  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await sleep(rand(600, 1200));
  for (const c of EMAIL) {
    await page.keyboard.type(c, { delay: rand(45, 120) });
    if (Math.random() < 0.04) await sleep(rand(200, 500));
  }
  await sleep(rand(400, 800));
  await page.keyboard.press("Enter");
  await sleep(rand(2500, 4500));

  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await sleep(rand(500, 1000));
  for (const c of PASSWORD) await page.keyboard.type(c, { delay: rand(45, 120) });
  await sleep(rand(300, 700));
  await page.keyboard.press("Enter");

  await page.waitForURL("https://club.com/**", { timeout: 35000 });
  await sleep(rand(2000, 3500));

  const cookies = await page.cookies();
  saveCookies(cookies);
  console.log("[session] logged in and cookies saved.");
}

async function ensureLoggedIn(page, EMAIL, PASSWORD) {
  // Check token directly via HTTPS — no browser needed
  const ok = await checkLoggedIn();
  if (ok) {
    console.log("[session] token valid ✅");
    return;
  }
  console.log("[session] token invalid, attempting Puppeteer login...");
  if (!page) {
    // Spin up a browser just for login
    const puppeteer = require("puppeteer-extra");
    const Stealth   = require("puppeteer-extra-plugin-stealth");
    puppeteer.use(Stealth());
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-blink-features=AutomationControlled","--window-size=1920,1080","--lang=en-US"],
      defaultViewport: { width: 1920, height: 1080 },
    });
    const p = await browser.newPage();
    try {
      await login(p, EMAIL, PASSWORD);
    } catch (e) {
      console.error("[session] login failed:", e.message);
      console.log("[session] exiting cleanly — update COOKIES_CXFAN_B64 secret.");
      await browser.close();
      process.exit(0);
    }
    await browser.close();
  } else {
    try {
      await login(page, EMAIL, PASSWORD);
    } catch (e) {
      console.error("[session] login failed:", e.message);
      console.log("[session] exiting cleanly — update COOKIES_CXFAN_B64 secret.");
      process.exit(0);
    }
  }
}

module.exports = { ensureLoggedIn, saveCookies };
