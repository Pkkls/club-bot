/**
 * Club.com Bot — cxfan
 *
 * Tyler, 23, Columbus OH. Amazon warehouse day shift (6-14:30 ET).
 * Watches IcePoseidon/CX crew since 2019. Online 15h-23h ET weekdays,
 * more on weekends. Max 1-3 comments/day. Checks replies, sometimes responds.
 */

const puppeteer  = require("puppeteer-extra");
const Stealth    = require("puppeteer-extra-plugin-stealth");
const AnonUA     = require("puppeteer-extra-plugin-anonymize-ua");
const Groq       = require("groq-sdk");
const fs         = require("fs");
const path       = require("path");
const persona    = require("./persona");
const { sendDailyDigest, sendMessage } = require("./telegram");

puppeteer.use(Stealth());
puppeteer.use(AnonUA({ makeWindows: true }));

// ─── Config ─────────────────────────────────────────────────────────────────
const EMAIL        = process.env.CLUB_EMAIL;
const PASSWORD     = process.env.CLUB_PASSWORD;
const GROQ_KEY = process.env.GROQ_API_KEY;
const ACCOUNT_NAME = "cxfan";
const BASE         = "https://club.com";
const STATE_FILE   = path.join(process.cwd(), "state_cxfan.json");
const HISTORY_FILE = path.join(process.cwd(), "history_cxfan.json");

// ─── Fingerprint ─────────────────────────────────────────────────────────────
function seedRng(seed) {
  let h = 0xdeadbeef;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 0x9e3779b9); h ^= h >>> 16; }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 0xffffffff; };
}

function buildFingerprint() {
  const rng = seedRng("cxfan_fp_v3");
  const ri  = (a, b) => Math.floor(rng() * (b - a + 1)) + a;
  // Tyler uses a mid-range Windows PC, 1080p monitor
  return {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    viewport:  { width: 1920, height: 1080 },
    timezone:  "America/New_York",
    locale:    "en-US",
    canvasSeed: 4821,
    webgl: { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  };
}

async function initPage(browser, fp) {
  const page = await browser.newPage();
  await page.setViewport(fp.viewport);
  await page.setUserAgent(fp.userAgent);
  await page.evaluateOnNewDocument((fp) => {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const s = fp.canvasSeed;
    const n = () => ((s * 9301 + 49297) % 233280) / 233280 * 2 - 1;
    HTMLCanvasElement.prototype.toDataURL = function(...a) {
      const ctx = this.getContext("2d");
      if (ctx) { const id = ctx.getImageData(0,0,this.width,this.height); for (let i=0;i<id.data.length;i+=4){id.data[i]=Math.max(0,Math.min(255,id.data[i]+n()));id.data[i+1]=Math.max(0,Math.min(255,id.data[i+1]+n()));} ctx.putImageData(id,0,0); }
      return origToDataURL.apply(this,a);
    };
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) { if(p===37445)return fp.webgl.vendor; if(p===37446)return fp.webgl.renderer; return gp.apply(this,arguments); };
    Object.defineProperty(navigator,"language",{get:()=>fp.locale});
    Object.defineProperty(navigator,"languages",{get:()=>[fp.locale,"en"]});
  }, fp);
  return page;
}

// ─── State & History ─────────────────────────────────────────────────────────
function loadState() {
  try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); } catch {}
  return { commented: [], followed: [], visited: [], sessionCount: 0, seenReplies: [], pendingReplies: [] };
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function loadHistory() {
  try { if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE,"utf8")); } catch {}
  return { account: ACCOUNT_NAME, comments: [], follows: [] };
}
function saveHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2)); }

function todayET() {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const offset = (month >= 3 && month <= 11) ? -4 : -5;
  return new Date(now.getTime() + offset * 3600000).toISOString().slice(0, 10);
}

function commentsToday(history) {
  const today = todayET();
  return history.comments.filter(c => c.ts.slice(0,10) === today && !c.isReply).length;
}

function logComment(history, entry) {
  history.comments.push({ ts: new Date().toISOString(), ...entry });
  saveHistory(history);
}
function logFollow(history, username) {
  history.follows.push({ ts: new Date().toISOString(), username });
  saveHistory(history);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => Math.floor(Math.random() * (b - a) + a);

async function api(page, method, endpoint, body) {
  return page.evaluate(async ({ method, endpoint, body, base }) => {
    try {
      const opts = { method, headers: {}, credentials: "include" };
      if (body) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
      const r = await fetch(base + endpoint, opts);
      if (!r.ok) return { _error: r.status };
      return r.json().catch(() => null);
    } catch (e) { return { _error: -1, _msg: e.message }; }
  }, { method, endpoint, body, base: BASE });
}

// ─── Persona prompt ───────────────────────────────────────────────────────────
const COMMENT_PROMPT = `You are cxfan, a 23yo American who watches a lot of streams. You're leaving a comment on a Club.com post.

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

GOOD (sounds human):
✅ "is that the same jacket from the Vegas clip"
✅ "didn't he say he was done with this last month"
✅ "the guy in the back is not happy lol"
✅ "how is this only 3 views"
✅ "wait they actually let him back"

Rules:
- 1 sentence, lowercase, no over-punctuation
- Sometimes a question, sometimes an observation, sometimes mild confusion
- Clean language — no slurs, no "fuck/shit" (platform rules)
- If the post gives you nothing specific to say, return empty string. Silence beats a generic comment every time.
- CRITICAL: never invent or assume facts about real events, places, or people that aren't explicitly stated in the caption. If the post references something you don't have concrete knowledge about, return empty string rather than guessing. A wrong detail is 10x worse than no comment.`;

const REPLY_PROMPT = `You are cxfan, a 23yo American who watches streams. Someone replied to your comment on Club.com.

You will receive:
- The original post context (what the post was about)
- Your comment you left
- The reply someone sent you

Your job is to decide TWO things:
1. Does this reply actually deserve a response? (most don't)
2. If yes, what would a real person say — based on the FULL context, not just reacting to the reply in isolation

WHEN TO RETURN EMPTY STRING (no reply):
- Their reply is 1-2 words or emoji only ("lol", "same", "fr", "💀")
- Their reply is generic agreement with nothing to add to
- You already made your point and they're just acknowledging it
- Responding would feel forced or like you're chasing engagement
- You have nothing new or specific to add

WHEN TO ACTUALLY REPLY:
- They asked you something specific that you have an actual answer to
- They pushed back on something you said — and you disagree with their pushback
- They added info that changes or builds on what you said
- There's a natural back-and-forth that would happen between two real people who just happen to be watching the same thing

HOW TO REPLY (if you do):
- Answer the SPECIFIC thing they said, not a generic "yeah" or "exactly"
- Your reply should make sense to someone reading the full thread
- 1 sentence, lowercase, conversational pace
- Don't be agreeable for the sake of it — Tyler has his own take
- Clean language (no slurs, no fuck/shit)
- Same banned list: no "w", "facts", "bro", "ngl", "fire", "based", "fair enough", "literally", "lowkey"

Return your reply text only, or empty string if not worth responding.`;

async function generateComment(post, imageB64 = null) {
  if (!GROQ_KEY) return null;
  const client = new Groq({ apiKey: GROQ_KEY });
  const caption = (post.caption || "").trim().substring(0, 400);
  const userMsg = caption
    ? `Post caption: "${caption}"\n\nWrite your comment (or empty string to skip):`
    : `Post type: ${post.contentType || "media"}, no caption.\n\nWrite your comment (or empty string to skip):`;
  try {
    const msg = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 80,
      messages: [{ role: "system", content: COMMENT_PROMPT }, { role: "user", content: userMsg }],
    });
    const text = msg.choices[0].message.content.trim().replace(/^["']|["']$/g, "");
    return text.length < 3 ? null : text;
  } catch (e) { console.error("[groq] comment error:", e.message); return null; }
}

const VERIFY_PROMPT = `You are a strict fact-checker reviewing a comment before it gets posted on Club.com.

You will receive:
- The post caption (context)
- The comment that was generated

Your job: decide if this comment should stay or be deleted.

DELETE if ANY of these are true:
- The comment references a fact, detail, or assumption about the post that isn't supported by the caption
- The comment could embarrass a real person if it's factually wrong (e.g., wrong info about an event, place, person)
- The comment sounds like it was written by an AI (generic, hollow, no real substance)
- The comment uses any banned words: "w", "L", "facts", "based", "ngl", "bro", "fire", "fair enough", "lowkey", "literally", "great content", "amazing"
- The comment is a single word or meaningless fragment

KEEP if:
- The comment reacts to something clearly stated in the caption
- OR makes a universally true observation (not event-specific) that fits the post
- AND sounds like something a real 23yo would type fast

Reply with exactly one word: KEEP or DELETE. Nothing else.`;

async function verifyComment(caption, comment) {
  if (!GROQ_KEY) return true; // no key = trust it
  const client = new Groq({ apiKey: GROQ_KEY });
  const ctx = [
    caption ? `Post caption: "${caption.substring(0, 300)}"` : "Post caption: (none)",
    `Comment to review: "${comment}"`,
  ].join("\n");
  try {
    const msg = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 5,
      messages: [{ role: "system", content: VERIFY_PROMPT }, { role: "user", content: ctx }],
    });
    const verdict = msg.choices[0].message.content.trim().toUpperCase();
    return verdict.startsWith("KEEP");
  } catch (e) { console.error("[groq] verify error:", e.message); return true; }
}

async function generateReply(postCaption, originalComment, theirReply, theirUsername) {
  if (!GROQ_KEY) return null;
  const client = new Groq({ apiKey: GROQ_KEY });

  const context = [
    postCaption ? `Post context: "${postCaption.substring(0, 300)}"` : "Post context: (no caption — media post)",
    `Your comment: "${originalComment}"`,
    `@${theirUsername} replied: "${theirReply}"`,
    "",
    "Reply with a single sentence if it genuinely warrants a response, or return empty string:",
  ].join("\n");

  try {
    const msg = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 80,
      messages: [{ role: "system", content: REPLY_PROMPT }, { role: "user", content: context }],
    });
    const text = msg.choices[0].message.content.trim().replace(/^["']|["']$/g, "");
    return text.length < 3 ? null : text;
  } catch (e) { console.error("[groq] reply error:", e.message); return null; }
}

async function fetchImageB64(page, url) {
  if (!url) return null;
  try {
    return await page.evaluate(async (u) => {
      try { const r = await fetch(u); if (!r.ok) return null; const b = await r.blob(); return new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result.split(",")[1]); rd.onerror = () => res(null); rd.readAsDataURL(b); }); }
      catch { return null; }
    }, url);
  } catch { return null; }
}

// ─── Score posts ──────────────────────────────────────────────────────────────
function scorePost(p) {
  const likes = p.likeCount || 0;
  const comments = p.commentCount || 0;
  const age_h = (Date.now() - new Date(p.createdAt || 0).getTime()) / 3600000;
  return (likes + (p.tipCount||0)*10) * (1 - Math.min(comments/(likes+1), 0.5)) * (0.5 + Math.max(0, 1-age_h/48)*0.5);
}

// ─── Reply checking ───────────────────────────────────────────────────────────
async function checkAndHandleReplies(page, state, history) {
  const recentComments = history.comments.filter(c => {
    if (c.isReply) return false;
    const ageH = (Date.now() - new Date(c.ts).getTime()) / 3600000;
    return ageH < 72; // only check comments from last 3 days
  });

  if (!recentComments.length) return 0;

  let repliesSent = 0;
  const todayReplies = history.comments.filter(c => c.isReply && c.ts.slice(0,10) === todayET()).length;

  for (const ourComment of recentComments) {
    if (!ourComment.postId || !ourComment.commentId) continue;

    try {
      const data = await api(page, "GET", `/api/feed/${ourComment.postId}/comments?limit=100`, null);
      const allComments = data?.data || data?.comments || [];

      // Find replies to our specific comment
      const replies = allComments.filter(c =>
        c.parentId === ourComment.commentId &&
        c.user?.username !== ACCOUNT_NAME &&
        !state.seenReplies.includes(c.id)
      );

      for (const reply of replies) {
        state.seenReplies.push(reply.id);
        // Keep seenReplies manageable
        if (state.seenReplies.length > 1000) state.seenReplies = state.seenReplies.slice(-500);

        const ageH = (Date.now() - new Date(reply.createdAt || 0).getTime()) / 3600000;
        const decide = persona.shouldReply(reply.text || "", ageH, todayReplies + repliesSent);

        console.log(`[reply] @${reply.user?.username} replied: "${(reply.text||"").substring(0,60)}" → ${decide ? "responding" : "ignoring"}`);

        if (decide) {
          await sleep(rand(5000, 15000)); // small pause before generating reply
          const replyText = await generateReply(ourComment.caption, ourComment.comment, reply.text || "", reply.user?.username || "user");
          if (replyText) {
            const res = await api(page, "POST", `/api/feed/${ourComment.postId}/comments`, { text: replyText, parentId: ourComment.commentId });
            if (res && !res._error) {
              repliesSent++;
              logComment(history, {
                postId: ourComment.postId,
                commentId: res.id,
                creator: ourComment.creator,
                comment: replyText,
                caption: ourComment.caption,
                isReply: true,
                replyingTo: (reply.text || "").substring(0, 80),
                replyingToUser: reply.user?.username,
              });
              console.log(`[reply] sent: "${replyText}"`);
              await sleep(rand(8000, 20000));
            }
          }
        }

        if (repliesSent >= 2) break; // cap per session
      }
    } catch (e) {
      console.error("[reply] error checking replies:", e.message);
    }

    saveState(state);
    await sleep(rand(2000, 5000));
  }

  return repliesSent;
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login(page) {
  console.log("[login] navigating...");
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(rand(2000, 3500));

  const me = await api(page, "GET", "/api/users/me", null);
  if (me && !me._error) { console.log(`[login] already logged in`); return; }

  try { await page.click('button::-p-text(Log in or sign up)'); } catch {
    const btns = await page.$$("button");
    for (const b of btns) { const t = await page.evaluate(el=>el.textContent,b); if (t?.includes("Log in")) { await b.click(); break; } }
  }
  await sleep(rand(1500, 3000));

  // Google button (~594,317 in 1280x720 → scale to 1920x1080)
  await page.mouse.click(Math.floor(594 * 1920/1280), Math.floor(317 * 1080/720));
  await sleep(rand(2500, 4000));

  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await sleep(rand(600, 1200));
  for (const c of EMAIL) { await page.keyboard.type(c, { delay: rand(45, 120) }); if (Math.random()<.04) await sleep(rand(200,500)); }
  await sleep(rand(400, 800));
  await page.keyboard.press("Enter");
  await sleep(rand(2500, 4500));

  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await sleep(rand(500, 1000));
  for (const c of PASSWORD) { await page.keyboard.type(c, { delay: rand(45, 120) }); }
  await sleep(rand(300, 700));
  await page.keyboard.press("Enter");

  await page.waitForURL("https://club.com/**", { timeout: 35000 });
  await sleep(rand(2000, 3500));
  console.log("[login] done");
}

// ─── Main session ─────────────────────────────────────────────────────────────
async function runSession(page, state, history) {
  // 1. Check Tyler's activity window
  const activityProb = persona.getActivityProbability();
  if (Math.random() > activityProb) {
    console.log(`[session] Tyler is not active right now (p=${activityProb.toFixed(2)}) — skipping`);
    return;
  }

  // 2. Check reply queue first (non-intrusive, Tyler checking his notifications)
  console.log("[session] checking replies...");
  const repliesSent = await checkAndHandleReplies(page, state, history);

  // 3. Determine comment budget for today
  const done = commentsToday(history);
  const budget = persona.getSessionCommentBudget(done);
  console.log(`[session] comments today: ${done}, budget this session: ${budget}`);

  if (budget === 0) {
    console.log("[session] no comment budget — Tyler is just browsing");
    // Still browse a bit (human signal)
    const feeds = ["/api/feed?type=hot&limit=20", "/api/feed?type=new&limit=20"];
    for (const f of feeds) { await api(page, "GET", f, null); await sleep(rand(3000, 8000)); }
    return;
  }

  // 4. Discover posts
  const seen = new Map();
  for (const ep of ["/api/feed?type=hot&limit=40", "/api/feed?type=new&limit=40", "/api/feed?type=discover&limit=30"]) {
    try {
      const data = await api(page, "GET", ep, null);
      for (const p of (data?.data || data?.posts || [])) {
        const c = p.creator || p.user;
        if (c?.username && !seen.has(p.id) && !state.commented.includes(p.id)) {
          seen.set(p.id, { ...p, _creator: c });
        }
      }
    } catch {}
  }

  // Sort by engagement score, pick from top candidates
  const candidates = [...seen.values()]
    .map(p => ({ ...p, _score: scorePost(p) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 30)
    .sort(() => Math.random() - 0.5); // shuffle top 30 for variety

  let commented = 0;

  for (const post of candidates) {
    if (commented >= budget) break;
    const creator = post._creator;
    if (!creator?.username || !post.id) continue;

    console.log(`\n[session] → @${creator.username}`);

    try {
      // Visit profile
      if (!state.visited.includes(creator.username)) {
        await api(page, "POST", "/api/users/me/profile-visits", { creatorId: creator.id });
        state.visited.push(creator.username);
        if (state.visited.length > 500) state.visited = state.visited.slice(-300);
        await sleep(rand(1500, 4000));
      }

      // Follow (sometimes)
      if (!state.followed.includes(creator.username) && persona.shouldFollow(false)) {
        const r = await api(page, "POST", `/api/follows/${creator.id}`, {});
        if (r && !r._error) {
          state.followed.push(creator.username);
          logFollow(history, creator.username);
          console.log(`[session] followed @${creator.username}`);
          await sleep(rand(2000, 5000));
        }
      }

      // Simulate reading the post
      await sleep(rand(3000, 8000));

      // Get image for Vision
      const imageB64 = await fetchImageB64(page, post.thumbnailUrl || post.imageUrl || null);

      // Generate comment
      const comment = await generateComment(post, imageB64);
      if (!comment) { console.log(`[session] nothing to say on @${creator.username}`); continue; }

      // Post it
      const res = await api(page, "POST", `/api/feed/${post.id}/comments`, { text: comment });
      if (!res || res._error) { console.log(`[session] post failed on @${creator.username}`); continue; }

      const commentId = res.id || res.data?.id;

      // Self-verify: re-read comment in context, delete if wrong
      console.log(`[session] verifying: "${comment}"`);
      const approved = await verifyComment(post.caption || "", comment);
      if (!approved) {
        console.log(`[session] ❌ verification failed — deleting comment on @${creator.username}`);
        await api(page, "DELETE", `/api/feed/${post.id}/comments/${commentId}`, null);
        await sleep(rand(3000, 7000));
        continue; // try next post
      }

      console.log(`[session] ✅ verified — keeping comment on @${creator.username}: "${comment}"`);
      state.commented.push(post.id);
      if (state.commented.length > 2000) state.commented = state.commented.slice(-1500);
      commented++;
      logComment(history, {
        postId: post.id,
        commentId,
        creator: creator.username,
        comment,
        caption: (post.caption || "").substring(0, 100),
      });

        // Sometimes like too
        if (Math.random() < 0.55) {
          await sleep(rand(1500, 4000));
          await api(page, "POST", `/api/feed/${post.id}/likes`, {});
        }

        await sleep(rand(15000, 35000)); // Tyler reads other comments after posting
      }
    } catch (e) {
      console.error(`[session] error on @${creator.username}:`, e.message);
    }

    saveState(state);
    await sleep(rand(8000, 20000));
  }

  state.sessionCount++;
  console.log(`\n[session] done. ${commented} comments this session, ${repliesSent} replies.`);
}

// ─── Telegram digest trigger ──────────────────────────────────────────────────
function shouldSendDigest() {
  // Send digest around 9pm ET (21h ET = 01h-02h UTC depending on DST)
  const h = persona.getEasternHour();
  return h >= 21 && h <= 22;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes("--history")) {
    const h = loadHistory();
    const last20 = h.comments.slice(-20);
    console.log(`\n=== cxfan history — ${h.comments.length} comments, ${h.follows.length} follows ===\n`);
    last20.forEach(c => console.log(`[${c.ts}] @${c.creator}${c.isReply ? " (reply)" : ""}: "${c.comment}"\n  post: "${c.caption}"\n`));
    return;
  }

  console.log(`\n===== Club Bot — cxfan =====`);
  const fp      = buildFingerprint();
  const state   = loadState();
  const history = loadHistory();

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-blink-features=AutomationControlled",`--window-size=1920,1080`,"--lang=en-US"],
    defaultViewport: fp.viewport,
  });

  const page = await initPage(browser, fp);

  try {
    await login(page);
    await runSession(page, state, history);
    saveState(state);

    // Send Telegram digest once per day in the evening
    if (shouldSendDigest()) {
      await sendDailyDigest(history);
    }
  } catch (e) {
    console.error("[fatal]", e.message);
    try { await page.screenshot({ path: "error.png" }); } catch {}
    // Notify Telegram on crash
    try { await sendMessage(`⚠️ <b>cxfan bot crashed</b>\n${e.message}`); } catch {}
    saveState(state);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
