/**
 * Tyler — the human behind cxfan
 *
 * 23yo, Columbus OH, works Amazon warehouse day shift (6am-2:30pm ET)
 * Single, lives with a roommate, watches streams since 2019
 * Dry humor, slightly contrarian, loyal to CX crew content
 * Plays Warzone occasionally, smokes weed on weekends
 */

// Eastern Time offset from UTC (approximation — -5 standard, -4 DST)
// We check month to approximate DST (Mar-Nov = EDT UTC-4, else EST UTC-5)
function getEasternHour() {
  const now = new Date();
  const month = now.getUTCMonth() + 1; // 1-12
  const offset = (month >= 3 && month <= 11) ? -4 : -5;
  return ((now.getUTCHours() + offset) + 24) % 24;
}

function getDayOfWeek() {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const offset = (month >= 3 && month <= 11) ? -4 : -5;
  const etMs = now.getTime() + offset * 3600000;
  return new Date(etMs).getDay(); // 0=Sun, 6=Sat
}

// Tyler's activity windows by day type
// Returns probability of being active in current hour (0-1)
function getActivityProbability() {
  const h   = getEasternHour();
  const day = getDayOfWeek();
  const isWeekend = day === 0 || day === 6;
  const isSunday  = day === 0;

  // Never active: working hours weekdays or sleeping
  if (!isWeekend && h >= 5 && h <= 14) return 0;   // at work
  if (h >= 1 && h <= 8) return 0;                   // sleeping

  if (isWeekend) {
    // Saturday: goes out at night → drops off after 8pm
    if (day === 6) {
      if (h >= 10 && h <= 13) return 0.5;  // morning catch-up
      if (h >= 14 && h <= 19) return 0.8;  // afternoon peak
      if (h >= 20 && h <= 23) return 0.2;  // likely out
      return 0.1;
    }
    // Sunday: most active day (recovery, streams all day)
    if (isSunday) {
      if (h >= 10 && h <= 17) return 0.9;
      if (h >= 18 && h <= 22) return 0.7;
      if (h >= 23 || h === 0) return 0.3;
      return 0.1;
    }
  }

  // Weekday
  if (h >= 15 && h <= 17) return 0.7;  // just got home, decompressing
  if (h >= 18 && h <= 21) return 0.9;  // prime evening time
  if (h >= 22 && h <= 23) return 0.5;  // winding down
  if (h === 0) return 0.2;             // late night scroll
  return 0.1;
}

// How many comments Tyler will make this session (if active)
// Small platform → stay low
function getSessionCommentBudget(dailyCommentsSoFar) {
  // Already commented today → much less likely to comment again
  if (dailyCommentsSoFar >= 3) return 0;
  if (dailyCommentsSoFar === 2) return Math.random() < 0.15 ? 1 : 0;
  if (dailyCommentsSoFar === 1) return Math.random() < 0.4 ? 1 : 0;

  // Fresh day: 0 comments yet
  const roll = Math.random();
  if (roll < 0.25) return 0;   // 25% — nothing caught his eye
  if (roll < 0.75) return 1;   // 50% — 1 comment
  if (roll < 0.95) return 2;   // 20% — 2 comments (good content day)
  return 3;                    // 5%  — active day (weekend/drama)
}

// Should Tyler follow someone this session?
function shouldFollow(alreadyFollowed) {
  if (alreadyFollowed) return false;
  return Math.random() < 0.3; // follows ~30% of new creators he visits
}

// Should Tyler reply to someone who replied to his comment?
function shouldReply(replyText, hoursSinceReply, repliesAlreadySentToday) {
  if (repliesAlreadySentToday >= 2) return false; // doesn't spam replies
  if (hoursSinceReply > 12) return false;         // moved on
  if (hoursSinceReply < 0.25) return false;       // too fast, looks bot-like

  const text = replyText.toLowerCase();

  // Single word / emoji-only → usually ignores
  if (text.split(/\s+/).length <= 2) return Math.random() < 0.1;

  // Someone asked a question → more likely to engage
  if (text.includes("?")) return Math.random() < 0.55;

  // Pushback / disagree → Tyler is slightly contrarian, might respond
  if (text.includes("wrong") || text.includes("nah") || text.includes("actually") || text.includes("no ")) {
    return Math.random() < 0.45;
  }

  // Generic agreement → probably ignores
  if (text.includes("lol") || text.includes("lmao") || text.includes("fr") || text.includes("real")) {
    return Math.random() < 0.12;
  }

  // Default: 25% chance
  return Math.random() < 0.25;
}

// Delay before replying (minutes) — human doesn't reply instantly
function getReplyDelay() {
  const roll = Math.random();
  if (roll < 0.3) return Math.floor(Math.random() * 30) + 10;    // 10-40 min
  if (roll < 0.7) return Math.floor(Math.random() * 90) + 30;    // 30-120 min
  return Math.floor(Math.random() * 180) + 90;                    // 90-270 min
}

module.exports = { getActivityProbability, getSessionCommentBudget, shouldFollow, shouldReply, getReplyDelay, getEasternHour };
