/**
 * Club.com Bot Orchestrator
 * Runs all registered accounts in sequence with human-like delays.
 *
 * Usage (from javascript_tool on any club.com tab):
 *   - Paste this script OR inject it
 *   - Each account needs its own Chrome profile / tab logged in
 *
 * For multi-account: open one tab per account, each logged in separately.
 * Call runAccount(tabId, persona) for each.
 */

const PERSONAS = {
  cxfan: {
    username: "cxfan",
    niche: "CX/gaming",
    targets: ["bijan", "henrik", "eddie", "sjc", "kangjoelll"],
    comments: {
      default: ["ngl didn't expect that", "actually makes sense", "lmao called it", "w", "fair enough", "not wrong", "finally someone said it", "clip lol"],
      kick: ["kick needs this badly tbh", "cx community wya"],
      feature: ["this one would actually change things", "been waiting for this"],
      giveaway: ["W post", "let's go"],
      track: ["send it", "actual menace"],
      update: ["good to know", "about time"],
    }
  }
  // Add more personas here:
  // account2: { username: "...", targets: [...], comments: {...} }
};

const STATE_KEY = "clubbot:state";

function loadState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); }
  catch { return {}; }
}
function saveState(s) { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }
async function humanDelay(min = 2000, max = 8000) { await sleep(rand(min, max)); }

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  try {
    const r = await fetch("https://club.com" + path, opts);
    if (!r.ok) { console.warn("[bot]", method, path, "->", r.status); return null; }
    return r.json().catch(() => null);
  } catch (e) { console.error("[bot] fetch error:", e); return null; }
}

function pickComment(persona, caption) {
  const c = (caption || "").toLowerCase();
  const cats = persona.comments;
  for (const [key, lines] of Object.entries(cats)) {
    if (key === "default") continue;
    if (c.includes(key)) return lines[rand(0, lines.length)];
  }
  const def = cats.default;
  return def[rand(0, def.length)];
}

async function runSession(personaName) {
  const persona = PERSONAS[personaName];
  if (!persona) { console.error("[bot] unknown persona:", personaName); return; }

  const state = loadState();
  if (!state[personaName]) state[personaName] = { commented: [], followed: [], visited: [] };
  const ps = state[personaName];

  const targets = [...persona.targets].sort(() => Math.random() - 0.5);
  console.log(`[bot:${personaName}] session start — ${targets.length} targets`);

  for (const username of targets) {
    try {
      const user = await api("GET", `/api/users/${username}`);
      if (!user?.id) continue;

      // Visit profile
      if (!ps.visited.includes(username)) {
        await api("POST", "/api/users/me/profile-visits", { creatorId: user.id });
        ps.visited.push(username);
        await humanDelay(1000, 3000);
      }

      // Follow
      if (!ps.followed.includes(username)) {
        const r = await api("POST", `/api/follows/${user.id}`, {});
        if (r) {
          ps.followed.push(username);
          console.log(`[bot:${personaName}] followed ${username}`);
        }
        await humanDelay();
      }

      // Comment on 1 fresh post
      const feed = await api("GET", `/api/feed?type=creator&username=${username}&limit=10`);
      const posts = (feed?.data || feed?.posts || []).filter(p => !ps.commented.includes(p.id));
      if (posts.length) {
        const post = posts[0];
        const comment = pickComment(persona, post.caption);
        const res = await api("POST", `/api/feed/${post.id}/comments`, { text: comment });
        if (res) {
          ps.commented.push(post.id);
          console.log(`[bot:${personaName}] commented on ${username}: "${comment}"`);
        }
        await humanDelay();
      }

    } catch (e) {
      console.error(`[bot:${personaName}] error on ${username}:`, e);
    }

    state[personaName] = ps;
    saveState(state);
    await humanDelay(8000, 20000);
  }

  console.log(`[bot:${personaName}] session done`);
}

// Run
window._botDone = false;
runSession("cxfan").then(() => { window._botDone = true; });
