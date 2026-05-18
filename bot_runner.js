// Club.com fan bot — runs directly in Chrome page context
// Inject via javascript_tool on https://club.com

(async function clubBot() {
  const BASE = 'https://club.com';
  const STATE_KEY = 'clubbot:state';

  const TARGETS = ['bijan', 'henrik', 'eddie', 'sjc', 'kangjoelll'];

  // ── Helpers ──────────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(min, max) { return Math.random() * (max - min) + min; }
  async function humanDelay() { await sleep(rand(2000, 7000)); }

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveState(s) { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(BASE + path, opts);
    if (!r.ok) { console.warn(`[bot] ${method} ${path} -> ${r.status}`); return null; }
    return r.json().catch(() => null);
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  async function getPosts(username, limit = 8) {
    const d = await api('GET', `/api/feed?type=creator&username=${username}&limit=${limit}`);
    return (d?.data || d?.posts || []);
  }

  async function postComment(postId, text) {
    return api('POST', `/api/feed/${postId}/comments`, { text });
  }

  async function followUser(userId) {
    return api('POST', `/api/follows/${userId}`, {});
  }

  async function getUser(username) {
    return api('GET', `/api/users/${username}`);
  }

  async function visitProfile(creatorId) {
    return api('POST', `/api/users/me/profile-visits`, { creatorId });
  }

  // ── Comment bank (fallback if no API key) ────────────────────────────────
  const COMMENTS = [
    'ngl didn\'t expect that',
    'actually makes sense',
    'lmao called it',
    'bro really said that with confidence',
    'w',
    'fair enough honestly',
    'ok but fr though',
    'took long enough',
    'not wrong',
    'this is actually huge',
    'finally someone said it',
    'clip lol',
  ];

  function pickComment(caption) {
    // Simple keyword matching for more relevant comments
    const c = (caption || '').toLowerCase();
    if (c.includes('kick')) return 'kick needs this badly tbh';
    if (c.includes('price') || c.includes('payout')) return 'numbers looking different rn';
    if (c.includes('update') || c.includes('announcement')) return 'good to know';
    if (c.includes('giveaway') || c.includes('give away')) return 'W post';
    if (c.includes('feature')) return 'this one would actually change things';
    if (c.includes('track') || c.includes('car')) return 'send it';
    return COMMENTS[Math.floor(Math.random() * COMMENTS.length)];
  }

  // ── Main session ──────────────────────────────────────────────────────────
  const state = loadState();
  if (!state.commented) state.commented = [];
  if (!state.followed) state.followed = [];
  if (!state.visited) state.visited = [];

  console.log('[bot] starting engagement session...');

  // Shuffle targets
  const targets = [...TARGETS].sort(() => Math.random() - 0.5);

  for (const username of targets) {
    console.log(`[bot] -- ${username} --`);
    try {
      const user = await getUser(username);
      if (!user) continue;
      const creatorId = user.id;

      // Visit profile
      if (!state.visited.includes(username)) {
        await visitProfile(creatorId);
        state.visited.push(username);
        console.log(`[bot] visited ${username}`);
        await humanDelay();
      }

      // Follow if not already
      if (!state.followed.includes(username)) {
        const r = await followUser(creatorId);
        if (r) {
          state.followed.push(username);
          console.log(`[bot] followed ${username}`);
        }
        await humanDelay();
      }

      // Comment on 1 recent post
      const posts = await getPosts(username, 10);
      const fresh = posts.filter(p => !state.commented.includes(p.id));
      if (fresh.length > 0) {
        const post = fresh[0];
        const comment = pickComment(post.caption || '');
        const result = await postComment(post.id, comment);
        if (result) {
          state.commented.push(post.id);
          console.log(`[bot] commented on ${post.id}: "${comment}"`);
        }
        await humanDelay();
      }

    } catch (e) {
      console.error(`[bot] error on ${username}:`, e);
    }

    saveState(state);
    await sleep(rand(10000, 25000));
  }

  console.log('[bot] session done. State:', JSON.stringify(state));
  return 'done';
})();
