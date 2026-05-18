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
const https      = require("https");
const fs         = require("fs");
const path       = require("path");
const persona    = require("./persona");
const { sendDailyDigest, sendMessage, checkCommands } = require("./telegram");
const { ensureLoggedIn }                        = require("./session");
const { trackCreator, recordInteraction, prioritize, getTrending } = require("./creators");
const { checkCommentMetrics }                   = require("./metrics");

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

function getAuthToken() {
  try {
    const cookies = JSON.parse(fs.readFileSync(path.join(process.cwd(), "cookies_cxfan.json"), "utf8"));
    return cookies.find(c => c.name === "chatAuthToken")?.value || null;
  } catch { return null; }
}

// Direct HTTPS call — bypasses Puppeteer/aws-waf-token (curl-equivalent)
async function api(method, endpoint, body) {
  const token = getAuthToken();
  return new Promise((resolve) => {
    const url     = new URL(BASE + endpoint);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      "Cookie":       token ? `chatAuthToken=${token}` : "",
      "Content-Type": "application/json",
      "Accept":       "application/json",
      "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      "Origin":       "https://club.com",
      "Referer":      "https://club.com/",
    };
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", d => data += d);
        res.on("end", () => {
          if (res.statusCode === 204) { resolve({}); return; }
          try { resolve(JSON.parse(data)); }
          catch { resolve({ _error: res.statusCode }); }
        });
      }
    );
    req.on("error", e => resolve({ _error: -1, _msg: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Persona prompt ───────────────────────────────────────────────────────────
const COMMENT_PROMPT = `You are cxfan, a 23yo American who watches a lot of streams. You're leaving a comment on a Club.com post.

A real comment notices something SPECIFIC — a detail in the background, something off about the caption, a recognizable face or place, something that doesn't add up, a callback to something that happened before. It sounds like someone who actually looked at the post for 3 seconds.

BANNED — never output any of these:
- Single word reactions: "w", "L", "facts", "real", "based", "wild", "crazy", "insane", "unreal", "mental"
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

async function generateComment(post) {
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


// ─── Score posts ──────────────────────────────────────────────────────────────
function scorePost(p) {
  const likes = p.likeCount || 0;
  const comments = p.commentCount || 0;
  const age_h = (Date.now() - new Date(p.createdAt || 0).getTime()) / 3600000;
  return (likes + (p.tipCount||0)*10) * (1 - Math.min(comments/(likes+1), 0.5)) * (0.5 + Math.max(0, 1-age_h/48)*0.5);
}

// ─── Reply checking ───────────────────────────────────────────────────────────
async function checkAndHandleReplies(state, history) {
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
      const data = await api("GET", `/api/feed/${ourComment.postId}/comments?limit=100`, null);
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
            const res = await api("POST", `/api/feed/${ourComment.postId}/comments`, { text: replyText, parentId: ourComment.commentId });
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
// Login handled by session.js (cookie-based, Google OAuth only when expired)

// ─── Main session ─────────────────────────────────────────────────────────────
async function runSession(state, history) {
  // 1. Check Tyler's activity window
  const activityProb = persona.getActivityProbability();
  if (Math.random() > activityProb) {
    console.log(`[session] Tyler is not active right now (p=${activityProb.toFixed(2)}) — skipping`);
    return;
  }

  // 2. Check reply queue first (non-intrusive, Tyler checking his notifications)
  console.log("[session] checking replies...");
  const repliesSent = await checkAndHandleReplies(state, history);

  // 3. Determine comment budget for today
  const done = commentsToday(history);
  const budget = persona.getSessionCommentBudget(done);
  console.log(`[session] comments today: ${done}, budget this session: ${budget}`);

  if (budget === 0) {
    console.log("[session] no comment budget — Tyler is just browsing");
    // Still browse a bit (human signal)
    const feeds = ["/api/feed?type=hot&limit=20", "/api/feed?type=new&limit=20"];
    for (const f of feeds) { await api("GET", f, null); await sleep(rand(3000, 8000)); }
    return;
  }

  // 4. Discover posts
  const seen = new Map();
  for (const ep of ["/api/feed?type=hot&limit=40", "/api/feed?type=new&limit=40", "/api/feed?type=discover&limit=30"]) {
    try {
      const data = await api("GET", ep, null);
      for (const p of (data?.data || data?.posts || [])) {
        const c = p.creator || p.user;
        if (c?.username && !seen.has(p.id) && !state.commented.includes(p.id)) {
          seen.set(p.id, { ...p, _creator: c });
        }
      }
    } catch {}
  }

  // Track all discovered creators in the network
  for (const p of seen.values()) {
    const c = p._creator;
    if (c?.username) trackCreator(state, c);
  }

  // Sort by engagement — but 20% of the time pick randomly (amélioration #3)
  const allPosts = [...seen.values()].map(p => ({ ...p, _score: scorePost(p) }));
  const useRandom = Math.random() < 0.2;
  const sorted = useRandom
    ? allPosts.sort(() => Math.random() - 0.5)
    : allPosts.sort((a, b) => b._score - a._score).slice(0, 30).sort(() => Math.random() - 0.5);
  // Boost trending/favorites creators (creators.js prioritize)
  const candidates = prioritize(sorted, state);

  console.log(`[session] post selection: ${useRandom ? "random" : "top engagement"}`);

  // Silent likes session — Tyler likes 3-8 posts without commenting (amélioration #1)
  const likeCandidates = allPosts.filter(p => !state.liked?.includes(p.id)).slice(0, 15);
  const likeCount = rand(3, 8);
  let liked = 0;
  if (!state.liked) state.liked = [];

  for (const post of likeCandidates.sort(() => Math.random() - 0.5)) {
    if (liked >= likeCount) break;
    await sleep(rand(2000, 6000));
    const r = await api("POST", `/api/feed/${post.id}/likes`, {});
    if (r && !r._error) {
      state.liked.push(post.id);
      if (state.liked.length > 500) state.liked = state.liked.slice(-400);
      liked++;
    }
  }
  console.log(`[session] silently liked ${liked} posts`);

  let commented = 0;

  for (const post of candidates) {
    if (commented >= budget) break;
    const creator = post._creator;
    if (!creator?.username || !post.id) continue;

    console.log(`\n[session] → @${creator.username}`);

    try {
      // Pre-filter: skip posts with not enough readable content
      const caption = post.caption || "";
      const usefulText = caption
        .replace(/\[emote:[^\]]+\]/g, "")  // strip emote tags
        .replace(/#\w+/g, "")              // strip hashtags
        .replace(/@\w+/g, "")             // strip mentions
        .replace(/https?:\/\/\S+/g, "")   // strip URLs
        .replace(/[^\w\s]/g, " ")         // strip punctuation/emoji
        .trim();
      if (usefulText.length < 25) {
        console.log(`[session] skipping @${creator.username} — not enough context`);
        continue;
      }

      // Visit profile
      if (!state.visited.includes(creator.username)) {
        await api("POST", "/api/users/me/profile-visits", { creatorId: creator.id });
        state.visited.push(creator.username);
        if (state.visited.length > 500) state.visited = state.visited.slice(-300);
        await sleep(rand(1500, 4000));
      }

      // Follow (sometimes)
      if (!state.followed.includes(creator.username) && persona.shouldFollow(false)) {
        const r = await api("POST", `/api/follows/${creator.id}`, {});
        if (r && !r._error) {
          state.followed.push(creator.username);
          logFollow(history, creator.username);
          recordInteraction(state, creator.username);
          console.log(`[session] followed @${creator.username}`);
          await sleep(rand(2000, 5000));
        }
      }

      // Simulate reading the post
      await sleep(rand(3000, 8000));

      // Generate comment
      const comment = await generateComment(post);
      if (!comment) { console.log(`[session] nothing to say on @${creator.username}`); continue; }

      // Post it
      const res = await api("POST", `/api/feed/${post.id}/comments`, { text: comment });
      if (!res || res._error) { console.log(`[session] post failed on @${creator.username}`); continue; }

      const commentId = res.id || res.data?.id;

      // Self-verify: re-read comment in context, delete if wrong
      console.log(`[session] verifying: "${comment}"`);
      const approved = await verifyComment(caption, comment);
      if (!approved) {
        console.log(`[session] ❌ verification failed — deleting and trying next post`);
        await api("DELETE", `/api/feed/${post.id}/comments/${commentId}`, null);
        await sleep(rand(3000, 7000));
        continue;
      }

      console.log(`[session] ✅ verified — keeping: "${comment}"`);
      state.commented.push(post.id);
      if (state.commented.length > 2000) state.commented = state.commented.slice(-1500);
      commented++;
      recordInteraction(state, creator.username);
      logComment(history, {
        postId: post.id,
        commentId,
        creator: creator.username,
        comment,
        caption: caption.substring(0, 100),
      });

      // Like after commenting — with human delay (amélioration #5 partiel)
      if (Math.random() < 0.55) {
        await sleep(rand(30000, 90000)); // Tyler reads other comments first
        await api("POST", `/api/feed/${post.id}/likes`, {});
      }

      await sleep(rand(15000, 35000));
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
function shouldSendDigest(state) {
  // Send digest around 9pm ET, at most once every 48h
  const h = persona.getEasternHour();
  if (h < 21 || h > 22) return false;
  const last = state.lastDigestSent || 0;
  return (Date.now() - last) >= 48 * 3600000;
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
  const state   = loadState();
  const history = loadHistory();

  try {
    await checkCommands(history);

    // Check token validity — if invalid, attempt login via Puppeteer
    await ensureLoggedIn(null, EMAIL, PASSWORD);

    await checkCommentMetrics(history);
    await runSession(state, history);
    saveState(state);

    if (shouldSendDigest(state)) {
      const trending = getTrending(state);
      await sendDailyDigest(history, trending);
      state.lastDigestSent = Date.now();
      saveState(state);
    }
  } catch (e) {
    console.error("[fatal]", e.message);
    try { await sendMessage(`⚠️ <b>cxfan bot crashed</b>\n${e.message}`); } catch {}
    saveState(state);
    process.exit(1);
  }
}

main();
