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

async function checkLoggedIn(page) {
  try {
    const result = await page.evaluate(async (base) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", base + "/api/feed?type=hot&limit=1", false);
      xhr.withCredentials = true;
      xhr.send();
      return xhr.status;
    }, BASE);
    return result === 200;
  } catch { return false; }
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
  // Try restoring existing session
  const restored = await restoreSession(page);
  if (restored) {
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 30000 });
    const ok = await checkLoggedIn(page);
    if (ok) {
      console.log("[session] restored from cookies ✅");
      return;
    }
    console.log("[session] cookies expired, re-logging in...");
  }
  await login(page, EMAIL, PASSWORD);
}

module.exports = { ensureLoggedIn, saveCookies };
