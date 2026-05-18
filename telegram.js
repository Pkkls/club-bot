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
    msg += `💬 <b>${todayComments.length} comment${todayComments.length > 1 ? "s" : ""}</b>\n`;
    msg += `<pre>`;
    msg += `Creator       | Comment\n`;
    msg += `${"─".repeat(60)}\n`;
    for (const c of todayComments) {
      const creator = `@${c.creator}`.padEnd(14);
      const comment = c.comment.length > 60 ? c.comment.slice(0, 57) + "..." : c.comment;
      msg += `${creator}| "${comment}"\n`;
      if (c.caption) {
        const ctx = c.caption.length > 55 ? c.caption.slice(0, 52) + "..." : c.caption;
        msg += `              | ↳ post: "${ctx}"\n`;
      }
      if (c.isReply) {
        msg += `              | ↳ reply to: "${(c.replyingTo || "").slice(0, 40)}"\n`;
      }
      msg += `\n`;
    }
    msg += `</pre>`;
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
