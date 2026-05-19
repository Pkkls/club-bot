/**
 * Telegram daily digest for cxfan bot activity
 * Sends once per day around 9pm ET with a table of comments + context
 */

const https = require("https");

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sendMessage(text) {
  return new Promise((resolve, reject) => {
    if (!TOKEN || !CHAT_ID) { resolve(); return; }
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" });
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/sendMessage`,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function formatDigest(history) {
  const today = todayUTC();

  const todayComments = history.comments.filter(c => c.ts.startsWith(today));
  const todayFollows  = history.follows.filter(f => f.ts.startsWith(today));

  if (todayComments.length === 0 && todayFollows.length === 0) {
    return `📊 <b>cxfan — Daily Report</b>\n${today}\n\nNo activity today.`;
  }

  let msg = `📊 <b>cxfan — Daily Report</b>\n${today}\n\n`;

  if (todayComments.length > 0) {
    msg += `💬 <b>${todayComments.length} comment${todayComments.length > 1 ? "s" : ""}</b>\n\n`;
    for (const c of todayComments) {
      const postUrl = c.postId ? `https://club.com/${c.creator}/post/${c.postId}` : null;
      const creatorLink = postUrl ? `<a href="${postUrl}">@${c.creator}</a>` : `@${c.creator}`;
      const label = c.isReply ? `↩ reply to ${creatorLink}` : creatorLink;
      msg += `${c.isReply ? "↩️" : "💬"} <b>${label}</b>`;
      msg += `\n`;
      msg += `"${c.comment}"\n`;
      if (c.caption) msg += `<i>post: "${c.caption.slice(0, 80)}${c.caption.length > 80 ? "..." : ""}"</i>\n`;
      if (c.isReply && c.replyingTo) msg += `<i>they said: "${c.replyingTo.slice(0, 60)}..."</i>\n`;
      msg += `\n`;
    }
  }

  if (todayFollows.length > 0) {
    msg += `\n👤 Followed: ${todayFollows.map(f => "@" + f.username).join(", ")}`;
  }

  // Stats
  const totalDays = Math.max(1, Math.ceil((Date.now() - new Date(history.comments[0]?.ts || Date.now()).getTime()) / 86400000));
  msg += `\n\n📈 Total: ${history.comments.length} comments · ${history.follows.length} follows`;

  return msg;
}

async function sendDailyDigest(history, trending = []) {
  let msg = formatDigest(history);

  // Append 72h metrics for comments that have been checked
  const withMetrics = history.comments.filter(c => c.checked && (c.likesReceived > 0 || c.repliesReceived > 0));
  if (withMetrics.length > 0) {
    msg += `\n\n📊 <b>72h engagement</b>\n`;
    for (const c of withMetrics.slice(-5)) {
      msg += `@${c.creator}: ${c.likesReceived || 0} likes · ${c.repliesReceived || 0} replies\n`;
    }
  }

  // Append trending creators
  if (trending.length > 0) {
    msg += `\n\n🔥 <b>Trending creators</b>\n`;
    for (const t of trending) {
      msg += `@${t.username} +${t.growthRate}% followers (7d)\n`;
    }
  }

  try {
    await sendMessage(msg);
    console.log("[telegram] Daily digest sent.");
  } catch (e) {
    console.error("[telegram] Failed to send digest:", e.message);
  }
}

function formatHistory(history) {
  const comments = history.comments.filter(c => !c.isReply).slice(-20).reverse();
  if (!comments.length) return "📜 <b>Historique</b>\n\nAucun commentaire pour l'instant.";
  let msg = `📜 <b>Historique — ${comments.length} derniers commentaires</b>\n\n`;
  for (const c of comments) {
    const url = `https://club.com/${c.creator}/post/${c.postId}`;
    msg += `<b>${c.ts.slice(0,10)}</b> · <a href="${url}">@${c.creator}</a>\n"${c.comment}"\n\n`;
  }
  msg += `📈 Total: ${history.comments.length} commentaires · ${history.follows.length} follows`;
  return msg;
}

async function checkCommands(history) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    const updates = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.telegram.org",
        path: `/bot${TOKEN}/getUpdates?timeout=3&allowed_updates=["message"]`,
        method: "GET",
      }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); });
      req.on("error", reject);
      req.end();
    });

    if (!updates.ok || !updates.result.length) return;
    let lastId = 0;

    for (const u of updates.result) {
      lastId = Math.max(lastId, u.update_id);
      const msg = u.message;
      if (!msg || String(msg.chat.id) !== String(CHAT_ID)) continue;
      if (msg.text === "/history") {
        await sendMessage(formatHistory(history));
        console.log("[telegram] /history sent.");
      }
    }

    // Acknowledge updates
    if (lastId > 0) {
      await new Promise((resolve) => {
        const req = https.request({ hostname: "api.telegram.org", path: `/bot${TOKEN}/getUpdates?offset=${lastId+1}&limit=1`, method: "GET" }, res => { res.on("data", ()=>{}); res.on("end", resolve); });
        req.on("error", resolve);
        req.end();
      });
    }
  } catch (e) { console.error("[telegram] checkCommands error:", e.message); }
}

module.exports = { sendDailyDigest, sendMessage, checkCommands };
