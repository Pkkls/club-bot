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
      const label = c.isReply ? `↩ reply to @${c.replyingToUser || c.creator}` : `@${c.creator}`;
      msg += `${c.isReply ? "↩️" : "💬"} <b>${label}</b>`;
      if (postUrl) msg += ` — <a href="${postUrl}">view post</a>`;
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

async function sendDailyDigest(history) {
  const msg = formatDigest(history);
  try {
    await sendMessage(msg);
    console.log("[telegram] Daily digest sent.");
  } catch (e) {
    console.error("[telegram] Failed to send digest:", e.message);
  }
}

module.exports = { sendDailyDigest, sendMessage };
