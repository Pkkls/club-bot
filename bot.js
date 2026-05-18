/**
 * Club.com Bot — Expert Farm Edition
 *
 * Architecture:
 * - puppeteer-extra + stealth: removes all headless detection vectors
 * - Per-account unique browser fingerprint (canvas, WebGL, UA, viewport, locale, timezone)
 * - Account warmup state machine: new→warming→active→resting
 * - Engagement-maximizing strategy: controversial openers, questions, reply-bait
 * - Claude Vision: reads actual post images for hyper-contextual comments
 * - Human timing: jittered delays, variable session length, non-linear behavior
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const AnonymizeUA = require("puppeteer-extra-plugin-anonymize-ua");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUA({ makeWindows: true }));

// ─── Env ────────────────────────────────────────────────────────────────────
const EMAIL        = process.env.CLUB_EMAIL;
const PASSWORD     = process.env.CLUB_PASSWORD;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || "default";
const BASE         = "https://club.com";
const STATE_FILE   = path.join(process.cwd(), `state_${ACCOUNT_NAME}.json`);
const HISTORY_FILE = path.join(process.cwd(), `history_${ACCOUNT_NAME}.json`);

// ─── Warmup thresholds ───────────────────────────────────────────────────────
// States: new → warming → active → resting (rotates)
// new:     only scroll/visit, no interaction
// warming: follow only (build signal), no comments yet
// active:  full engagement (follow + comment + reply-bait)
// resting: do nothing this session (looks human)
const WARMUP = {
  new:     { sessions: 5,  canFollow: false, canComment: false, restChance: 0.2 },
  warming: { sessions: 15, canFollow: true,  canComment: false, restChance: 0.3 },
  active:  { sessions: 999,canFollow: true,  canComment: true,  restChance: 0.15 },
};

// ─── Fingerprint seeding ────────────────────────────────────────────────────
// Each account gets a deterministic but unique fingerprint derived from its name.
// Same account = same fingerprint every run = consistent identity.
function seedRng(seed) {
  let h = 0xdeadbeef;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x9e3779b9);
    h ^= h >>> 16;
  }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 0xffffffff; };
}

function buildFingerprint(accountName) {
  const rng = seedRng(accountName + "_fp_v2");
  const ri  = (a, b) => Math.floor(rng() * (b - a + 1)) + a;

  // Realistic Chrome/Windows UA pool
  const chromeVersions = ["124.0.0.0", "125.0.0.0", "126.0.0.0", "130.0.0.0", "134.0.0.0", "136.0.0.0"];
  const cv = chromeVersions[ri(0, chromeVersions.length - 1)];
  const winVersions = ["10.0", "10.0"];
  const wv = winVersions[ri(0, winVersions.length - 1)];

  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ];
  const vp = viewports[ri(0, viewports.length - 1)];

  const timezones = [
    "America/New_York", "America/Chicago", "America/Denver",
    "America/Los_Angeles", "America/Phoenix", "America/Detroit",
  ];
  const tz = timezones[ri(0, timezones.length - 1)];

  const locales = ["en-US", "en-US", "en-US", "en-GB", "en-CA"];
  const locale  = locales[ri(0, locales.length - 1)];

  // Canvas noise seed (used in page injection)
  const canvasSeed = ri(1000, 9999);

  // WebGL spoofing
  const gpus = [
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (AMD)",    renderer: "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  ];
  const gpu = gpus[ri(0, gpus.length - 1)];

  return {
    userAgent: `Mozilla/5.0 (Windows NT ${wv}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${cv} Safari/537.36`,
    viewport: vp,
    timezone: tz,
    locale,
    canvasSeed,
    webgl: gpu,
  };
}

// ─── Stealth page init ───────────────────────────────────────────────────────
async function initPage(browser, fp) {
  const page = await browser.newPage();
  await page.setViewport(fp.viewport);
  await page.setUserAgent(fp.userAgent);

  // Inject fingerprint spoofs before any page load
  await page.evaluateOnNewDocument((fp) => {
    // Canvas noise: add subtle per-pixel noise so canvas fingerprint is unique
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const seed = fp.canvasSeed;
    const noise = () => ((seed * 9301 + 49297) % 233280) / 233280 * 2 - 1;

    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const ctx = this.getContext("2d");
      if (ctx) {
        const id = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < id.data.length; i += 4) {
          id.data[i]   = Math.max(0, Math.min(255, id.data[i]   + noise()));
          id.data[i+1] = Math.max(0, Math.min(255, id.data[i+1] + noise()));
        }
        ctx.putImageData(id, 0, 0);
      }
      return origToDataURL.apply(this, args);
    };

    // WebGL vendor/renderer spoof
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return fp.webgl.vendor;
      if (param === 37446) return fp.webgl.renderer;
      return getParam.apply(this, arguments);
    };
    const getParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return fp.webgl.vendor;
      if (param === 37446) return fp.webgl.renderer;
      return getParam2.apply(this, arguments);
    };

    // Timezone
    Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
      construct(target, args) {
        if (!args[1]) args[1] = {};
        if (!args[1].timeZone) args[1].timeZone = fp.timezone;
        return new target(...args);
      }
    });

    // Navigator language
    Object.defineProperty(navigator, "language",  { get: () => fp.locale });
    Object.defineProperty(navigator, "languages", { get: () => [fp.locale, "en"] });

    // Hide automation cues not caught by stealth plugin
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
    delete window.callPhantom;
    delete window._phantom;
  }, fp);

  return page;
}

// ─── State management ────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return {
    commented: [],
    followed: [],
    visited: [],
    sessionCount: 0,
    warmupPhase: "new",
    totalComments: 0,
    totalFollows: 0,
    createdAt: Date.now(),
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {}
  return { account: ACCOUNT_NAME, comments: [], follows: [] };
}

function logComment(history, { postId, creator, comment, postCaption }) {
  history.comments.push({
    ts: new Date().toISOString(),
    postId,
    creator,
    comment,
    caption: (postCaption || "").substring(0, 100),
  });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function logFollow(history, { username }) {
  history.follows.push({ ts: new Date().toISOString(), username });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function printHistory() {
  const h = loadHistory();
  console.log(`\n===== History for ${h.account} =====`);
  console.log(`Total comments: ${h.comments.length} | Total follows: ${h.follows.length}\n`);
  h.comments.slice(-20).forEach(c => {
    console.log(`[${c.ts}] @${c.creator} → "${c.comment}"`);
    if (c.caption) console.log(`  post: "${c.caption}"`);
  });
}

function getPhase(state) {
  const sc = state.sessionCount;
  if (sc < WARMUP.new.sessions) return "new";
  if (sc < WARMUP.new.sessions + WARMUP.warming.sessions) return "warming";
  return "active";
}

// ─── Human timing ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

// Simulate reading time based on content length
function readDelay(text = "") {
  const wpm = rand(180, 280); // human reading speed
  const words = text.split(/\s+/).length;
  return Math.max(800, Math.floor((words / wpm) * 60000) + rand(-200, 500));
}

// ─── API calls ───────────────────────────────────────────────────────────────
async function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body, base }) => {
    try {
      const opts = { method, headers: {}, credentials: "include" };
      if (body) {
        opts.headers["content-type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      const r = await fetch(base + path, opts);
      if (!r.ok) return { _error: r.status, _msg: await r.text().catch(() => "") };
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) return r.json().catch(() => null);
      return null;
    } catch (e) {
      return { _error: -1, _msg: e.message };
    }
  }, { method, path, body, base: BASE });
}

// ─── Creator discovery ───────────────────────────────────────────────────────
async function discoverCreators(page) {
  const seen = new Map();
  // Mix of feeds for diversity
  const endpoints = [
    "/api/feed?type=hot&limit=40",
    "/api/feed?type=new&limit=40",
    "/api/feed?type=discover&limit=40",
    "/api/feed?type=trending&limit=40",
  ];
  for (const ep of endpoints) {
    try {
      const data = await api(page, "GET", ep, null);
      const posts = data?.data || data?.posts || [];
      for (const p of posts) {
        const c = p.creator || p.user;
        if (c?.username && !seen.has(c.username)) {
          // Attach engagement metrics for targeting strategy
          seen.set(c.username, {
            ...c,
            _postEngagement: (p.commentCount || 0) + (p.likeCount || 0) + (p.tipCount || 0) * 5,
            _commentCount: p.commentCount || 0,
            _samplePost: p,
          });
        }
      }
    } catch {}
  }
  return [...seen.values()];
}

// ─── Post scoring for engagement-maximizing targeting ────────────────────────
// Strategy: target posts with:
// - High views/likes (viral → more people see our comment)
// - Low comment count relative to views (comment stands out more)
// - Recent (last 24h ideally)
function scorePost(post) {
  const likes    = post.likeCount    || 0;
  const comments = post.commentCount || 0;
  const tips     = post.tipCount     || 0;
  const age_h    = (Date.now() - new Date(post.createdAt || 0).getTime()) / 3600000;

  // Sweet spot: viral but low comment density (our comment is visible)
  const engagement = likes + tips * 10;
  const commentDensity = comments / (likes + 1);
  const freshness = Math.max(0, 1 - age_h / 48);

  return engagement * (1 - Math.min(commentDensity, 0.5)) * (0.5 + freshness * 0.5);
}

// ─── Claude comment generation ───────────────────────────────────────────────
// Engagement-maximizing strategy:
// 1. Ask a question → triggers replies
// 2. Make a provocative but non-toxic take → triggers debate
// 3. React to something SPECIFIC in the post (image/caption detail)
// 4. Reference something a regular viewer would catch
// Never: generic praise, emojis spam, obvious AI patterns

const SYSTEM_PROMPT = `You are cxfan, a 23yo American who watches a lot of streams. You're leaving a comment on a Club.com post.

A real comment notices something SPECIFIC — a detail in the background, something off about the caption, a recognizable face or place, something that doesn't add up, a callback to something that happened before. It sounds like someone who actually looked at the post for 3 seconds.

BANNED — never output any of these:
- Single word reactions: "w", "L", "facts", "real", "based", "wild", "crazy"
- Filler: "fair enough", "fair point", "makes sense", "this", "this one", "no cap", "fr fr", "ngl", "bro", "fam", "lowkey", "literally"
- Hype words: "fire", "heat", "slaps", "bussin", "let's go", "let's gooo"
- Generic praise: "great content", "keep it up", "love this", "amazing", "incredible", "so good"
- AI patterns: "this one would actually X", "genuinely X", "honestly X", "not gonna lie"
- Anything that reacts to a vibe instead of a specific detail in the post

BAD (bot giveaway):
❌ "w"
❌ "fair enough"
❌ "this one would actually change things"
❌ "ngl this hits different"
❌ "no cap bro"

GOOD (sounds human):
✅ "is that the same jacket from the Vegas clip"
✅ "didn't he say he was done with this last month"
✅ "the guy in the back is not happy lol"
✅ "how is this only 3 views"
✅ "wait they actually let him back"
✅ "that looks exactly like the spot near his old place"

Rules:
- 1 sentence, lowercase, no over-punctuation
- Sometimes a question, sometimes an observation, sometimes mild confusion
- Clean language — no slurs, no "fuck/shit" (platform rules)
- If the post gives you nothing specific to say, return empty string. Silence beats a generic comment every time.`;

async function generateComment(post, imageB64 = null) {
  if (!ANTHROPIC_KEY) return null;
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const caption = post.caption?.trim()?.substring(0, 400) || "";
  const postType = post.contentType || "media";

  let userContent = [];

  // Add image if available (Claude Vision)
  if (imageB64) {
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: imageB64 },
    });
  }

  const textCtx = caption
    ? `Post caption: "${caption}"\nPost type: ${postType}`
    : `Post type: ${postType}, no caption provided.`;

  userContent.push({
    type: "text",
    text: `${textCtx}\n\nWrite your comment (single line, or empty string to skip):`,
  });

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 80,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    const text = msg.content[0].text.trim().replace(/^["']|["']$/g, "").replace(/^empty string$/i, "");
    return text.length < 3 ? null : text;
  } catch (e) {
    console.error("Claude API error:", e.message);
    return null;
  }
}

// ─── Fetch post thumbnail for Vision ─────────────────────────────────────────
async function fetchImageB64(page, imageUrl) {
  if (!imageUrl) return null;
  try {
    return await page.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const blob = await r.blob();
        return new Promise((res) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(",")[1]);
          reader.onerror = () => res(null);
          reader.readAsDataURL(blob);
        });
      } catch { return null; }
    }, imageUrl);
  } catch { return null; }
}

// ─── Login ───────────────────────────────────────────────────────────────────
async function login(page, fp) {
  console.log("[login] Navigating to club.com...");
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(rand(2000, 4000));

  // Check if already logged in
  const me = await api(page, "GET", "/api/users/me", null);
  if (me && !me._error) {
    console.log(`[login] Already logged in as ${me.username || "unknown"}`);
    return;
  }

  // Click login button
  try {
    await page.click('button::-p-text(Log in or sign up)');
  } catch {
    // Try alternate selectors
    const btns = await page.$$("button");
    for (const b of btns) {
      const txt = await page.evaluate(el => el.textContent, b);
      if (txt && txt.includes("Log in")) { await b.click(); break; }
    }
  }
  await sleep(rand(1500, 3000));

  // Click Google provider button (icon-only, positioned ~594,317 in 1280x720)
  // Scale to actual viewport
  const scaleX = fp.viewport.width  / 1280;
  const scaleY = fp.viewport.height / 720;
  const gx = Math.floor(594 * scaleX);
  const gy = Math.floor(317 * scaleY);

  // Try to find it by position or by being 2nd button in modal
  let clicked = false;
  const allBtns = await page.$$("button");
  for (const btn of allBtns) {
    const box = await btn.boundingBox();
    if (!box) continue;
    if (box.x > gx - 60 && box.x < gx + 60 && box.y > gy - 40 && box.y < gy + 40) {
      await btn.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) await page.mouse.click(gx, gy);
  await sleep(rand(2000, 4000));

  // Google login flow
  console.log("[login] Filling Google credentials...");
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await sleep(rand(500, 1200));

  // Type like a human (variable speed, occasional pause)
  for (const char of EMAIL) {
    await page.keyboard.type(char, { delay: rand(40, 130) });
    if (Math.random() < 0.05) await sleep(rand(200, 600)); // occasional pause mid-typing
  }
  await sleep(rand(400, 900));
  await page.keyboard.press("Enter");
  await sleep(rand(2500, 4500));

  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await sleep(rand(500, 1200));
  for (const char of PASSWORD) {
    await page.keyboard.type(char, { delay: rand(40, 130) });
  }
  await sleep(rand(300, 800));
  await page.keyboard.press("Enter");

  console.log("[login] Waiting for redirect...");
  await page.waitForURL("https://club.com/**", { timeout: 35000 });
  await sleep(rand(2000, 4000));
  console.log("[login] Logged in.");
}

// ─── Session runner ──────────────────────────────────────────────────────────
async function runSession(page, state, history) {
  const phase = getPhase(state);
  const cfg   = WARMUP[phase];
  state.warmupPhase = phase;

  console.log(`[session] Phase: ${phase} | Session #${state.sessionCount + 1}`);

  // Sometimes just rest (looks human — account not always active)
  if (Math.random() < cfg.restChance) {
    console.log("[session] Resting this session (human behavior)");
    state.sessionCount++;
    return;
  }

  // Discover creators
  console.log("[session] Discovering creators...");
  const creators = await discoverCreators(page);
  console.log(`[session] Found ${creators.length} creators`);

  // Sort by engagement score for targeting strategy (active phase)
  // In warming phase, pick random ones to not look like a scraper
  let targets;
  if (phase === "active") {
    targets = creators
      .sort((a, b) => (b._postEngagement || 0) - (a._postEngagement || 0))
      .slice(0, 20) // top 20 by engagement
      .sort(() => Math.random() - 0.5) // then shuffle (don't always hit same order)
      .slice(0, rand(5, 10)); // take 5-10 per session
  } else {
    targets = creators.sort(() => Math.random() - 0.5).slice(0, rand(3, 7));
  }

  let commentsThisSession = 0;
  let followsThisSession  = 0;
  const maxComments = rand(2, 5); // cap per session to avoid spam signal

  for (const creator of targets) {
    const { username, id: creatorId } = creator;
    if (!username || !creatorId) continue;
    console.log(`\n[session] → ${username} (phase: ${phase})`);

    try {
      // 1. Visit profile (always — builds organic signal)
      if (!state.visited.includes(username)) {
        await api(page, "POST", "/api/users/me/profile-visits", { creatorId });
        state.visited.push(username);
        // Keep visited list manageable
        if (state.visited.length > 500) state.visited = state.visited.slice(-300);
        await sleep(readDelay(username));
      }

      // 2. Follow (warming + active, ~35% chance on unseen creators)
      if (cfg.canFollow && !state.followed.includes(username) && Math.random() < 0.35) {
        const r = await api(page, "POST", `/api/follows/${creatorId}`, {});
        if (r && !r._error) {
          state.followed.push(username);
          followsThisSession++;
          console.log(`[session] followed ${username}`);
          logFollow(history, { username });
        }
        await sleep(rand(2000, 5000));
      }

      // 3. Comment (active phase only, with cap)
      if (cfg.canComment && commentsThisSession < maxComments) {
        const feed = await api(page, "GET", `/api/feed?type=creator&username=${username}&limit=15`, null);
        const posts = (feed?.data || feed?.posts || []).filter(p => p.id && !state.commented.includes(p.id));

        if (posts.length) {
          // Pick best post to comment on (highest score, low comment density)
          const scored = posts.map(p => ({ post: p, score: scorePost(p) }))
            .sort((a, b) => b.score - a.score);

          // Pick from top 3 (not always the best — adds variance)
          const pick = scored[rand(0, Math.min(2, scored.length - 1))];
          const post = pick.post;

          // Get thumbnail for Vision if available
          const imageUrl = post.thumbnailUrl || post.imageUrl || post.mediaUrl;
          const imageB64 = imageUrl ? await fetchImageB64(page, imageUrl) : null;

          // Simulate reading the post
          await sleep(readDelay(post.caption || ""));

          const comment = await generateComment(post, imageB64);

          if (comment) {
            const res = await api(page, "POST", `/api/feed/${post.id}/comments`, { text: comment });
            if (res && !res._error) {
              state.commented.push(post.id);
              state.totalComments++;
              commentsThisSession++;
              console.log(`[session] commented on ${username}: "${comment}"`);
              logComment(history, { postId: post.id, creator: username, comment, postCaption: post.caption });

              // After commenting, sometimes like the post too (looks natural)
              if (Math.random() < 0.6) {
                await sleep(rand(1500, 4000));
                await api(page, "POST", `/api/feed/${post.id}/likes`, {});
              }

              await sleep(rand(4000, 12000)); // long pause after commenting
            } else {
              console.log(`[session] comment failed on ${username}: ${JSON.stringify(res)}`);
            }
          } else {
            console.log(`[session] skipped ${username} (nothing specific to say)`);
          }
        }
      }

    } catch (e) {
      console.error(`[session] error on ${username}:`, e.message);
    }

    saveState(state);
    // Inter-creator delay: longer in warming phase (more cautious)
    const minDelay = phase === "new" ? 5000 : phase === "warming" ? 12000 : 8000;
    const maxDelay = phase === "new" ? 15000 : phase === "warming" ? 35000 : 25000;
    await sleep(rand(minDelay, maxDelay));
  }

  state.sessionCount++;
  state.totalFollows += followsThisSession;
  console.log(`\n[session] Done. Comments: ${commentsThisSession}, Follows: ${followsThisSession}`);
  console.log(`[session] Totals: ${state.totalComments} comments, ${state.totalFollows} follows (session #${state.sessionCount})`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // CLI: node bot.js --history  → just print last 20 comments and exit
  if (process.argv.includes("--history")) {
    printHistory();
    process.exit(0);
  }

  console.log(`\n===== Club Bot | Account: ${ACCOUNT_NAME} =====`);

  const fp      = buildFingerprint(ACCOUNT_NAME);
  const state   = loadState();
  const history = loadHistory();

  console.log(`[init] Fingerprint: ${fp.userAgent.substring(0, 60)}...`);
  console.log(`[init] Viewport: ${fp.viewport.width}x${fp.viewport.height} | TZ: ${fp.timezone}`);
  console.log(`[init] State: phase=${getPhase(state)}, sessions=${state.sessionCount}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins",
      "--disable-site-isolation-trials",
      `--window-size=${fp.viewport.width},${fp.viewport.height}`,
      `--lang=${fp.locale}`,
    ],
    defaultViewport: fp.viewport,
    ignoreHTTPSErrors: false,
  });

  const page = await initPage(browser, fp);

  try {
    await login(page, fp);
    await runSession(page, state, history);
    saveState(state);
  } catch (e) {
    console.error("[fatal]", e.message);
    try { await page.screenshot({ path: "error.png", fullPage: false }); } catch {}
    saveState(state);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
