/**
 * One-time login — opens real Chrome window, waits for login, saves cookies.
 * After logging in, the script waits 10 minutes then auto-saves.
 */
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
const fs        = require("fs");
puppeteer.use(Stealth());

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800", "--lang=en-US"],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  await page.goto("https://club.com", { waitUntil: "networkidle2", timeout: 45000 });
  await new Promise(r => setTimeout(r, 2000));

  // Click "Log in"
  try {
    await page.click('button::-p-text(Log in)');
  } catch {
    const btns = await page.$$("button");
    for (const b of btns) {
      const t = await page.evaluate(el => el.textContent, b);
      if (t?.includes("Log in") || t?.includes("Sign")) { await b.click(); break; }
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // Click Google
  try {
    await page.click('button::-p-text(Google)');
  } catch {
    await page.mouse.click(594, 317);
  }

  console.log("=== Waiting for you to log in (up to 10 minutes) ===");

  // Poll until chatAuthToken appears or 10min timeout
  const start = Date.now();
  let saved = false;
  while (Date.now() - start < 600000) {
    await new Promise(r => setTimeout(r, 3000));
    const cookies = await page.cookies();
    const hasToken = cookies.find(c => c.name === "chatAuthToken");
    if (hasToken) {
      fs.writeFileSync("cookies_cxfan.json", JSON.stringify(cookies, null, 2));
      console.log(`DONE — saved ${cookies.length} cookies: ${cookies.map(c=>c.name).join(", ")}`);
      saved = true;
      break;
    }
  }

  if (!saved) console.error("Timeout — no chatAuthToken found.");
  await browser.close();
})();
