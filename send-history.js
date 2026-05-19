const { sendMessage } = require('./telegram');
const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(process.cwd(), 'history_cxfan.json');
const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));

const lines = h.comments.slice(-20).map(c => {
  const d = new Date(c.ts).toLocaleString('fr-FR', { timeZone: 'America/New_York', hour12: false });
  const url = c.postId ? `https://club.com/${c.creator}/post/${c.postId}` : null;
  const link = url ? `<a href="${url}">@${c.creator}</a>` : `@${c.creator}`;
  const tag = c.isReply ? ' ↩️' : '';
  return `<b>${link}</b>${tag} — ${d}\n💬 "${c.comment}"\n📝 ${(c.caption || '(no caption)').substring(0, 80)}`;
}).join('\n\n');

const msg = `<b>📋 cxfan history — ${h.comments.length} comments, ${h.follows.length} follows</b>\n\n${lines}`;

sendMessage(msg).then(() => { console.log('sent'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
