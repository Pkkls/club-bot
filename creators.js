/**
 * Creator network management
 * - Tracks follower counts over time
 * - Detects trending creators (+15% in 7 days)
 * - Maintains Tyler's "favorites" network (creators he's interacted with)
 * - Priorizes trending + favorites in session targeting
 */

const TRENDING_THRESHOLD = 0.15; // +15% followers in 7 days
const NETWORK_MAX        = 200;  // max creators to track

function getNetwork(state) {
  if (!state.creatorNetwork) state.creatorNetwork = {};
  return state.creatorNetwork;
}

// Called on every creator visit — updates follower count history
function trackCreator(state, creator) {
  const net = getNetwork(state);
  const username = creator.username;
  if (!username) return;

  const now       = Date.now();
  const followers = creator.followersCount || creator.followerCount || 0;

  if (!net[username]) {
    net[username] = {
      firstSeen:      now,
      lastSeen:       now,
      interactionCount: 0,
      followerHistory: [],
      trending:       false,
    };
  }

  const entry = net[username];
  entry.lastSeen = now;

  // Store follower snapshot (keep last 10)
  entry.followerHistory.push({ ts: now, count: followers });
  if (entry.followerHistory.length > 10) entry.followerHistory.shift();

  // Detect trending: compare current vs 7 days ago
  const sevenDaysAgo = now - 7 * 24 * 3600000;
  const old = entry.followerHistory.find(h => h.ts <= sevenDaysAgo);
  if (old && old.count > 0 && followers > 0) {
    const growth = (followers - old.count) / old.count;
    entry.trending = growth >= TRENDING_THRESHOLD;
    entry.growthRate = Math.round(growth * 100);
  }

  // Prune old/unvisited creators to keep state lean
  const keys = Object.keys(net);
  if (keys.length > NETWORK_MAX) {
    // Remove least recently seen
    keys.sort((a, b) => net[a].lastSeen - net[b].lastSeen);
    delete net[keys[0]];
  }
}

// Called when we comment/follow — marks as "interacted"
function recordInteraction(state, username) {
  const net = getNetwork(state);
  if (net[username]) net[username].interactionCount++;
}

// Sort candidates by priority:
// 1. Trending creators (fast growth)
// 2. Creators we've interacted with before (favorites)
// 3. Everyone else
function prioritize(candidates, state) {
  const net = getNetwork(state);

  return candidates.sort((a, b) => {
    const ua = a._creator?.username;
    const ub = b._creator?.username;
    const na = net[ua] || {};
    const nb = net[ub] || {};

    const scoreA = (na.trending ? 100 : 0) + (na.interactionCount || 0) * 10;
    const scoreB = (nb.trending ? 100 : 0) + (nb.interactionCount || 0) * 10;

    return scoreB - scoreA;
  });
}

// Returns list of trending creators for Telegram digest
function getTrending(state) {
  const net = getNetwork(state);
  return Object.entries(net)
    .filter(([, v]) => v.trending)
    .map(([username, v]) => ({ username, growthRate: v.growthRate || 0 }))
    .sort((a, b) => b.growthRate - a.growthRate)
    .slice(0, 5);
}

module.exports = { trackCreator, recordInteraction, prioritize, getTrending };
