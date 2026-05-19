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

// Timezone-aware cooldown multiplier (ET)
// Peak 15h–22h → 0.45x (Tyler off work, active)
// Shoulder 12h–15h, 22h–0h → 0.75x
// Morning 8h–12h → 1.0x
// Night 0h–8h → 1.8x (barely online, very slow)
function paceMultiplier() {
  const h = persona.getEasternHour();
  if (h >= 15 && h < 22) return 0.45;
  if ((h >= 12 && h < 15) || (h >= 22)) return 0.75;
  if (h >= 8 && h < 12) return 1.0;
  return 1.8; // 0h–8h
}
// pace(a, b) — like rand(a, b) but scaled to current ET hour
function pace(a, b) { const m = paceMultiplier(); return rand(Math.round(a * m), Math.round(b * m)); }

function getAuthCookieStr() {
  try {
    const cookies = JSON.parse(fs.readFileSync(path.join(process.cwd(), "cookies_cxfan.json"), "utf8"));
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  } catch { return ""; }
}

// Direct HTTPS call — bypasses Puppeteer/aws-waf-token (curl-equivalent)
async function api(method, endpoint, body) {
  const cookieStr = getAuthCookieStr();
  return new Promise((resolve) => {
    const url     = new URL(BASE + endpoint);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      "Cookie":       cookieStr,
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

// Tyler's full psychological profile — used in all prompts
const TYLER_PERSONA = `You are Tyler ("cxfan"), 23 years old, Columbus OH.

BACKGROUND:
- Amazon warehouse worker, day shift 6am–2:30pm ET. On his phone during breaks, on his PC after 3pm.
- Grew up lower-middle class, never went to college, no regrets about it
- Has watched IcePoseidon (Paul Denino) and the CX crew since 2019: KangJoel, SJC, Tazo, ABZ, Ac7onman, ChickenAndy, SHoovy, EBZ, SamPepper, Taemin, Xenathewitch, NickWhite, BurgerPlanet, MANDO, Nanatty, NickLee, Suspendas
- Also watches Kick streams: CS2, FPS, variety content — but CX is his main scene
- Has a memory for drama — he's seen callouts, beefs, bans, comeback streams, the whole arc

PSYCHOLOGICAL PROFILE:
- Emotionally flat by default. Doesn't hype things up. Doesn't perform enthusiasm.
- Mildly paranoid — always looks for what's off about something, what's being sold, who's the angle
- Has strong opinions he rarely states directly. Prefers oblique observations that imply his take.
- Not looking to make friends in comments. Doesn't engage for the sake of engagement.
- Will only type something if it occurred to him naturally — not if he's trying to add value
- His humor is dry. The joke is usually in what he leaves unsaid.
- He's been burned by believing streamers before. Now he watches with detachment.
- Knows the difference between authentic moments and content — and is quietly contemptuous of the latter

WHEN TYLER COMMENTS (rare):
- He noticed something specific the poster probably didn't realize was visible
- He remembers something from a past stream that makes this post ironic or suspicious
- The caption is wrong about something he happens to know
- Something about the framing or angle of the shot is off and he can't let it go
- It's a callback to drama and he was there when it happened

WHEN TYLER STAYS SILENT (most of the time):
- Generic content with no hooks
- Content that's clearly farming engagement
- Posts where there's nothing concrete to push back on or reference
- When he'd just be saying what everyone else is saying`;

const COMMENT_PROMPT = `${TYLER_PERSONA}

YOUR TASK: Leave a comment on a Club.com post. You have already been told (via a prior analysis step) that this post is worth commenting on. Now write the actual comment.

A real Tyler comment notices something SPECIFIC — a detail in the background, something off about the caption, a recognizable face or place, a callback to something that happened, a contradiction, something that doesn't add up.

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

GOOD (sounds like Tyler):
✅ "is that the same jacket from the Vegas clip"
✅ "didn't he say he was done with this last month"
✅ "the guy in the back is not happy lol"
✅ "how is this only 3 views"
✅ "wait they actually let him back"
✅ "paul said the exact same thing before the miami thing happened"
✅ "kangJoel called this like three weeks ago"

Rules:
- 1 sentence, lowercase, no over-punctuation
- Sometimes a question, sometimes an observation, sometimes mild confusion
- Clean language — no slurs, no "fuck/shit" (platform rules)
- If the post gives you nothing specific to say, return empty string. Silence beats a generic comment every time.
- CRITICAL: never invent or assume facts about real events, places, or people that aren't explicitly stated in the caption or analysis. A wrong detail is 10x worse than no comment.`;

// ─── Prompt 1: Post context analyzer ─────────────────────────────────────────
const ANALYZE_PROMPT = `You analyze Club.com posts for a CX/streaming community viewer.

Your job: extract all the relevant signals from a post so a downstream system can decide whether it's worth commenting on.

Output ONLY a JSON object with these fields (no prose, no markdown):
{
  "creator": "username or null",
  "cx_relevant": true/false,  // involves IcePoseidon, CX crew (KangJoel, SJC, Tazo, ABZ, Ac7onman, ChickenAndy, SHoovy, EBZ, SamPepper, Taemin, Xenathewitch, NickWhite, BurgerPlanet, MANDO, Nanatty, NickLee, Suspendas) or known drama
  "has_hook": true/false,  // is there something specific to react to (detail, contradiction, callback, irony)
  "hook_description": "short description of the hook or null",
  "content_type": "drama|milestone|collab|gameplay|irl|vlog|promo|generic",
  "farming_signal": true/false,  // looks like engagement bait with no substance
  "post_age_minutes": number or null,  // estimate if inferable
  "tone": "neutral|hype|sad|funny|drama"
}`;

async function analyzePost(post) {
  if (!GROQ_KEY) return null;
  const client = new Groq({ apiKey: GROQ_KEY });
  const caption = (post.caption || "").trim().substring(0, 500);
  const creator = post._creator?.username || "unknown";
  const userMsg = [
    `Creator: @${creator}`,
    caption ? `Caption: "${caption}"` : "Caption: (none)",
    `Content type: ${post.contentType || "unknown"}`,
    `Likes: ${post.likeCount || 0}, Comments: ${post.commentCount || 0}`,
  ].join("\n");

  try {
    const msg = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: ANALYZE_PROMPT }, { role: "user", content: userMsg }],
    });
    return JSON.parse(msg.choices[0].message.content);
  } catch (e) { console.error("[groq] analyze error:", e.message); return null; }
}

// ─── Prompt 2: Comment decision (score 0-10) ──────────────────────────────────
const DECIDE_PROMPT = `${TYLER_PERSONA}

You receive a structured analysis of a Club.com post. Decide if Tyler would comment on it.

Score 0-10 on "Tyler's likelihood of typing something here":
- 0-3: Tyler scrolls past. Generic, no hook, nothing to say.
- 4-5: Borderline. Mildly interesting but nothing specific to push back on.
- 6-7: Tyler pauses. There's a specific detail, callback, or contradiction worth noting.
- 8-10: Tyler definitely comments. CX drama, clear callback, something objectively off.

Rules:
- farming_signal = true → subtract 3 (Tyler ignores bait)
- cx_relevant = true and has_hook = true → add 2
- content_type = "promo" or "generic" → subtract 2
- post_age old or very fresh and no hook → subtract 1

Output ONLY a JSON object: {"score": number, "reason": "one sentence"}`;

async function shouldCommentOnPost(analysis) {
  if (!GROQ_KEY || !analysis) return { score: 0, reason: "no analysis" };
  const client = new Groq({ apiKey: GROQ_KEY });
  const userMsg = `Post analysis:\n${JSON.stringify(analysis, null, 2)}\n\nScore Tyler's likelihood to comment:`;
  try {
    const msg = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 80,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: DECIDE_PROMPT }, { role: "user", content: userMsg }],
    });
    return JSON.parse(msg.choices[0].message.content);
  } catch (e) { console.error("[groq] decide error:", e.message); return { score: 0, reason: "error" }; }
}

// ─── Jury system: 3 jurors vote on generated comment ─────────────────────────
const JURY_PROMPTS = {
  linguist: `You are a linguistics expert reviewing a comment for naturalness. Your only question: does this sound like a real 23yo American typed it fast, or does it sound generated?

DELETE if:
- Any banned words: "w", "L", "facts", "based", "ngl", "bro", "fire", "fair enough", "lowkey", "literally", "great content", "amazing", "wild", "crazy", "insane"
- AI sentence structure: "this one would X", "genuinely X", "honestly X", "not gonna lie X"
- Overly complete sentences that no one types in a comment box
- Perfect grammar where a human would contract or skip punctuation

KEEP if: sounds like rapid natural typing, lowercase, specific, imperfect-but-not-try-hard

Reply with exactly: KEEP or DELETE`,

  sociologist: `You are a social dynamics expert reviewing whether this comment will read as authentic or bot-like in a streaming community context.

DELETE if:
- The comment is generic enough to fit on ANY post (not specific to this one)
- It's reacting to a vibe or energy instead of a concrete detail
- It's the kind of thing someone says to seem relatable rather than because they actually noticed something
- It references facts or events not supported by the caption

KEEP if: reacts to something specific and observable in the post

Reply with exactly: KEEP or DELETE`,

  paranoid: `You are a paranoid platform moderator looking for bot patterns.

DELETE if:
- Any word from the banned list: "w", "L", "facts", "real", "based", "wild", "crazy", "insane", "unreal", "fire", "heat", "slaps", "bussin", "let's go", "ngl", "bro", "fam", "lowkey", "literally", "fr fr", "no cap", "great content", "keep it up", "love this", "amazing"
- The comment could apply to 1000 different posts without modification
- It's a single word or fragment with no meaning
- It sounds like praise or engagement farming

KEEP if: specific, grounded in actual post content, sounds like someone who watched the thing

Reply with exactly: KEEP or DELETE`,
};

async function juryVote(caption, comment) {
  if (!GROQ_KEY) return true;
  const client = new Groq({ apiKey: GROQ_KEY });
  const ctx = [
    caption ? `Post caption: "${caption.substring(0, 300)}"` : "Post caption: (none)",
    `Comment to review: "${comment}"`,
  ].join("\n");

  const votes = await Promise.all(
    Object.entries(JURY_PROMPTS).map(async ([name, sysprompt]) => {
      try {
        const msg = await client.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          max_tokens: 5,
          messages: [{ role: "system", content: sysprompt }, { role: "user", content: ctx }],
        });
        const v = msg.choices[0].message.content.trim().toUpperCase();
        const keep = v.startsWith("KEEP");
        console.log(`  [jury:${name}] ${keep ? "✅ KEEP" : "❌ DELETE"}`);
        return keep;
      } catch (e) { console.error(`[jury:${name}] error:`, e.message); return true; } // benefit of doubt on error
    })
  );

  const keepVotes = votes.filter(Boolean).length;
  console.log(`  [jury] result: ${keepVotes}/3 KEEP`);
  return keepVotes >= 2; // majority rules — 2/3 needed to post
}

const REPLY_PROMPT = `${TYLER_PERSONA}

Someone replied to your comment on Club.com.

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

async function generateComment(post, analysis) {
  if (!GROQ_KEY) return null;
  const client = new Groq({ apiKey: GROQ_KEY });
  const caption = (post.caption || "").trim().substring(0, 400);
  const hookHint = analysis?.hook_description ? `\n[Analysis hook: ${analysis.hook_description}]` : "";
  const userMsg = caption
    ? `Post caption: "${caption}"${hookHint}\n\nWrite your comment (or empty string to skip):`
    : `Post type: ${post.contentType || "media"}, no caption.${hookHint}\n\nWrite your comment (or empty string to skip):`;
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
          await sleep(pace(3000, 10000)); // small pause before generating reply
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
              await sleep(pace(5000, 15000));
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
  // 1. Check Tyler's activity window (FORCE_SESSION=true bypasses for testing)
  const activityProb = persona.getActivityProbability();
  if (!process.env.FORCE_SESSION && Math.random() > activityProb) {
    console.log(`[session] Tyler is not active right now (p=${activityProb.toFixed(2)}) — skipping`);
    return;
  }

  // 2. Check reply queue first (non-intrusive, Tyler checking his notifications)
  console.log("[session] checking replies...");
  const repliesSent = await checkAndHandleReplies(state, history);

  // 3. Determine comment budget for today
  const done = commentsToday(history);
  const budget = process.env.FORCE_SESSION ? 1 : persona.getSessionCommentBudget(done);
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
    await sleep(pace(1000, 4000));
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

      // #4 Timing window: skip posts < 20min or > 3h old
      const postAgeMin = post.createdAt
        ? (Date.now() - new Date(post.createdAt).getTime()) / 60000
        : null;
      if (postAgeMin !== null && !process.env.FORCE_SESSION) {
        if (postAgeMin < 20) {
          console.log(`[session] skipping @${creator.username} — too fresh (${Math.round(postAgeMin)}min)`);
          continue;
        }
        if (postAgeMin > 180) {
          console.log(`[session] skipping @${creator.username} — too old (${Math.round(postAgeMin)}min)`);
          continue;
        }
      }

      // #7 Double context analysis — Prompt 1: analyze post
      console.log(`[session] analyzing post from @${creator.username}...`);
      const analysis = await analyzePost(post);
      if (analysis) {
        console.log(`[session] analysis: cx_relevant=${analysis.cx_relevant}, has_hook=${analysis.has_hook}, type=${analysis.content_type}, farming=${analysis.farming_signal}`);
      }

      // #7 Double context analysis — Prompt 2: score/decide
      const decision = await shouldCommentOnPost(analysis);
      const COMMENT_THRESHOLD = 6;
      console.log(`[session] decision score: ${decision.score}/10 — ${decision.reason}`);
      if (!process.env.FORCE_SESSION && decision.score < COMMENT_THRESHOLD) {
        console.log(`[session] skipping @${creator.username} — score too low (${decision.score} < ${COMMENT_THRESHOLD})`);
        continue;
      }

      // Visit profile
      if (!state.visited.includes(creator.username)) {
        await api("POST", "/api/users/me/profile-visits", { creatorId: creator.id });
        state.visited.push(creator.username);
        if (state.visited.length > 500) state.visited = state.visited.slice(-300);
        await sleep(pace(800, 2500));
      }

      // Follow (sometimes)
      if (!state.followed.includes(creator.username) && persona.shouldFollow(false)) {
        const r = await api("POST", `/api/follows/${creator.id}`, {});
        if (r && !r._error) {
          state.followed.push(creator.username);
          logFollow(history, creator.username);
          recordInteraction(state, creator.username);
          console.log(`[session] followed @${creator.username}`);
          await sleep(pace(1200, 3500));
        }
      }

      // Simulate reading the post
      await sleep(pace(2000, 6000));

      // Generate comment (with analysis context passed in)
      const comment = await generateComment(post, analysis);
      if (!comment) { console.log(`[session] nothing to say on @${creator.username}`); continue; }

      // Post it
      const res = await api("POST", `/api/feed/${post.id}/comments`, { text: comment });
      if (!res || res._error) { console.log(`[session] post failed on @${creator.username}`); continue; }

      const commentId = res.id || res.data?.id;

      // #1 Jury system: 3 jurors vote, 2/3 needed to keep
      console.log(`[session] jury voting on: "${comment}"`);
      const juryApproved = await juryVote(caption, comment);
      if (!juryApproved) {
        console.log(`[session] ❌ jury rejected — deleting and trying next post`);
        await api("DELETE", `/api/feed/${post.id}/comments/${commentId}`, null);
        await sleep(pace(2000, 5000));
        continue;
      }

      // Self-verify: re-read comment in context, delete if wrong
      console.log(`[session] verifying: "${comment}"`);
      const approved = await verifyComment(caption, comment);
      if (!approved) {
        console.log(`[session] ❌ verification failed — deleting and trying next post`);
        await api("DELETE", `/api/feed/${post.id}/comments/${commentId}`, null);
        await sleep(pace(2000, 5000));
        continue;
      }

      console.log(`[session] ✅ jury + verify passed — keeping: "${comment}"`);
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
        await sleep(pace(12000, 45000)); // Tyler reads other comments first
        await api("POST", `/api/feed/${post.id}/likes`, {});
      }

      await sleep(pace(8000, 22000));
    } catch (e) {
      console.error(`[session] error on @${creator.username}:`, e.message);
    }

    saveState(state);
    await sleep(pace(4000, 12000));
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
