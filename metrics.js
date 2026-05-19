/**
 * Post-comment metrics tracking
 * 72h after each comment: re-fetch the post, log likes + replies received.
 * Also detects who followed us back (for network H).
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const { updateEngagementScore } = require("./creators");

const COOKIES_FILE = path.join(process.cwd(), "cookies_cxfan.json");

function getToken() {
  try {
    const c = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    return c.find(x => x.name === "chatAuthToken")?.value || null;
  } catch { return null; }
}

function apiGet(endpoint) {
  const token = getToken();
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "club.com",
        path: endpoint,
        method: "GET",
        headers: {
          "Cookie": token ? `chatAuthToken=${token}` : "",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
      (res) => {
        let data = "";
        res.on("data", d => data += d);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function checkCommentMetrics(history, state) {
  const now      = Date.now();
  const hours72  = 72 * 3600000;
  const unchecked = history.comments.filter(c =>
    !c.checked &&
    !c.isReply &&
    c.commentId &&
    c.postId &&
    (now - new Date(c.ts).getTime()) >= hours72
  );

  if (!unchecked.length) return;
  console.log(`[metrics] checking ${unchecked.length} comment(s) at 72h...`);

  for (const c of unchecked) {
    try {
      const data = await apiGet(`/api/feed/${c.postId}/comments?limit=100`);
      const comments = data?.data || data?.comments || [];
      const ours = comments.find(x => x.id === c.commentId);

      if (ours) {
        c.likesReceived   = ours.likeCount || 0;
        c.repliesReceived = (ours.replies || []).length;

        if (!history.network) history.network = {};
        for (const reply of (ours.replies || [])) {
          const u = reply.user?.username;
          if (u) {
            if (!history.network[u]) history.network[u] = { replies: 0, likes: 0 };
            history.network[u].replies++;
          }
        }
      }

      c.checked = true;
      console.log(`[metrics] @${c.creator}: ${c.likesReceived || 0} likes, ${c.repliesReceived || 0} replies`);
      // #D — update cold score
      if (state) updateEngagementScore(state, c.creator, c.likesReceived || 0, c.repliesReceived || 0);
    } catch (e) {
      console.error(`[metrics] error on ${c.commentId}:`, e.message);
    }
  }
}

module.exports = { checkCommentMetrics };
