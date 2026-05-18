/**
 * Club.com Bot — Node.js + Puppeteer
 * - Discovers creators dynamically from platform feeds
 * - Generates comments via Claude API based on actual post content
 * - Runs on GitHub Actions (free, no PC needed)
 */

const puppeteer = require("puppeteer");
const Anthropic = require("@anthropic-ai/sdk");

const EMAIL = process.env.CLUB_EMAIL;
const PASSWORD = process.env.CLUB_PASSWORD;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || "default";

const BASE = "https://club.com";
const STATE_KEY = `clubbot:${ACCOUNT_NAME}`;

const PERSONA_SYSTEM = `You are ${ACCOUNT_NAME}, a 23-year-old US viewer on Club.com. You watch Kick streams — IcePoseidon, CX crew, gaming, variety.

Write ONE short comment for a post. Rules:
- 1 sentence max, sometimes just a few words
- Lowercase is fine, occasional typo ok
- React to the SPECIFIC content of the post
- Never generic praise ("great content", "love this", "amazing")
- Never emojis unless it's one that genuinely fits
- Sound like someone scrolling fast and tapping a quick reply
- If the post has no useful context, say nothing interesting happened — just skip (return empty string)`;

async function generateComment(postCaption, postType) {
  if (!ANTHROPIC_KEY) return null;
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const ctx = postCaption?.trim()
    ? `Post: "${postCaption.substring(0, 300)}"`
    : `Post type: ${postType || "media"}, no caption.`;
  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 60,
    system: PERSONA_SYSTEM,
    messages: [{ role: "user", content: `${ctx}\n\nWrite your comment (or empty string to skip):` }],
  });
  const text = msg.content[0].text.trim().replace(/^["']|["']$/g, "");
  return text.length < 3 ? null : text;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

async function login(page) {
  console.log("Navigating to club.com...");
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await sleep(2000);

  // Click "Log in or sign up"
  await page.click('button::-p-text(Log in or sign up)');
  await sleep(2000);

  // Click Google button (2nd provider icon in modal)
  const buttons = await page.$$("button");
  // Find visible buttons in the modal area
  let googleBtn = null;
  for (const btn of buttons) {
    const box = await btn.boundingBox();
    if (!box) continue;
    // Google button is roughly at x:560-620, y:300-340 in 1280x720
    if (box.x > 550 && box.x < 650 && box.y > 290 && box.y < 350) {
      googleBtn = btn;
      break;
    }
  }

  if (!googleBtn) {
    // Fallback: click by coordinate
    await page.mouse.click(594, 317);
  } else {
    await googleBtn.click();
  }
  await sleep(3000);

  console.log("Filling Google credentials...");
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.type('input[type="email"]', EMAIL, { delay: rand(50, 120) });
  await page.keyboard.press("Enter");
  await sleep(3000);

  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.type('input[type="password"]', PASSWORD, { delay: rand(50, 120) });
  await page.keyboard.press("Enter");

  console.log("Waiting for redirect...");
  await page.waitForURL("https://club.com/**", { timeout: 30000 });
  await sleep(3000);
  console.log("Logged in.");
}

async function apiCall(page, method, path, body) {
  return page.evaluate(async ({ method, path, body, base }) => {
    const opts = { method, headers: {} };
    if (body) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
    const r = await fetch(base + path, opts);
    if (!r.ok) return { _error: r.status };
    return r.json().catch(() => null);
  }, { method, path, body, base: BASE });
}

async function discoverCreators(page, limit = 30) {
  // Pull from multiple feeds to get a diverse set
  const feeds = ["hot", "new", "discover"];
  const seen = new Map();

  for (const feedType of feeds) {
    const data = await apiCall(page, "GET", `/api/feed?type=${feedType}&limit=${limit}`);
    const posts = data?.data || data?.posts || [];
    for (const p of posts) {
      const c = p.creator;
      if (c && !seen.has(c.username)) seen.set(c.username, c);
    }
  }
  return [...seen.values()];
}

async function runSession(page) {
  // Load state from page localStorage
  let state = await page.evaluate((key) => {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  }, STATE_KEY);
  if (!state.commented) state.commented = [];
  if (!state.followed) state.followed = [];
  if (!state.visited) state.visited = [];

  const saveState = async () => page.evaluate(
    (key, s) => localStorage.setItem(key, JSON.stringify(s)),
    STATE_KEY, state
  );

  // Discover creators dynamically
  console.log("Discovering creators...");
  const creators = await discoverCreators(page, 30);
  // Shuffle and take up to 8 per session
  const targets = creators.sort(() => Math.random() - 0.5).slice(0, 8);
  console.log(`Targeting ${targets.length} creators`);

  for (const creator of targets) {
    const { username, id: creatorId } = creator;
    console.log(`-- ${username} --`);

    try {
      // Visit profile
      if (!state.visited.includes(username)) {
        await apiCall(page, "POST", "/api/users/me/profile-visits", { creatorId });
        state.visited.push(username);
        await sleep(rand(1000, 3000));
      }

      // Follow (only some — ~40% chance if not already following)
      if (!state.followed.includes(username) && Math.random() < 0.4) {
        const r = await apiCall(page, "POST", `/api/follows/${creatorId}`, {});
        if (r && !r._error) {
          state.followed.push(username);
          console.log(`followed ${username}`);
        }
        await sleep(rand(1500, 4000));
      }

      // Comment on 1 fresh post
      const feed = await apiCall(page, "GET", `/api/feed?type=creator&username=${username}&limit=10`);
      const posts = (feed?.data || feed?.posts || []).filter(p => !state.commented.includes(p.id));

      if (posts.length) {
        const post = posts[rand(0, Math.min(3, posts.length))]; // pick from first 3 fresh posts
        const comment = await generateComment(post.caption, post.contentType);

        if (comment) {
          const res = await apiCall(page, "POST", `/api/feed/${post.id}/comments`, { text: comment });
          if (res && !res._error) {
            state.commented.push(post.id);
            console.log(`commented on ${username}: "${comment}"`);
          }
          await sleep(rand(3000, 8000));
        } else {
          console.log(`skipped comment on ${username} (no good angle)`);
        }
      }

    } catch (e) {
      console.error(`error on ${username}:`, e.message);
    }

    await saveState();
    await sleep(rand(10000, 25000));
  }

  console.log("Session done.");
  console.log(`Stats: ${state.commented.length} commented, ${state.followed.length} followed`);
}

async function main() {
  console.log(`Starting bot for account: ${ACCOUNT_NAME}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 1280, height: 720 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  );

  try {
    await login(page);
    await runSession(page);
  } catch (e) {
    console.error("Fatal error:", e);
    await page.screenshot({ path: "error.png" });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
