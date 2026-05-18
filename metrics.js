/**
 * Post-comment metrics tracking
 * 72h after each comment: re-fetch the post, log likes + replies received.
 * Also detects who followed us back (for network H).
 */

const BASE = "https://club.com";

async function checkCommentMetrics(page, history) {
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
      const data = await page.evaluate(async ({ base, postId, commentId }) => {
        try {
          const r = await fetch(`${base}/api/feed/${postId}/comments?limit=100`, { credentials: "include" });
          if (!r.ok) return null;
          return r.json();
        } catch { return null; }
      }, { base: BASE, postId: c.postId, commentId: c.commentId });

      const comments = data?.data || data?.comments || [];
      const ours = comments.find(x => x.id === c.commentId);

      if (ours) {
        c.likesReceived   = ours.likeCount || 0;
        c.repliesReceived = (ours.replies || []).length;

        // Log repliers to network
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
    } catch (e) {
      console.error(`[metrics] error on ${c.commentId}:`, e.message);
    }
  }
}

module.exports = { checkCommentMetrics };
