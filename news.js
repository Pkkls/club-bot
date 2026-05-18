/**
 * Scrapes latest tweets from CX/Kick accounts to inject current context
 * into comment generation. Skips pinned tweets.
 *
 * Sources (no API key needed — uses public RSS via nitter):
 * @Jacooola, @cx_clips, @ClipsVonClaus, @Nolimitzor_X, @KickStreaming, @Ice_Poseidon
 */

const https = require("https");

const ACCOUNTS = [
  "Jacooola",
  "cx_clips",
  "ClipsVonClaus",
  "Nolimitzor_X",
  "KickStreaming",
  "Ice_Poseidon",
];

// Public nitter instances (fallback chain if one is down)
const NITTER_INSTANCES = [
  "nitter.privacydev.net",
  "nitter.poast.org",
  "nitter.1d4.us",
];

function fetchUrl(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers: { "User-Agent": "Mozilla/5.0 (compatible; RSS reader)" }, timeout: 8000 }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function parseRSS(xml, account) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];

    // Skip pinned tweets (nitter marks them with "pinned" in category)
    if (item.includes("<category>pinned</category>")) continue;

    const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
    const linkMatch  = item.match(/<link>(.*?)<\/link>/);
    const dateMatch  = item.match(/<pubDate>(.*?)<\/pubDate>/);

    if (!titleMatch) continue;

    const title = titleMatch[1]
      .replace(/^R to @\w+:\s*/i, "")  // skip replies
      .replace(/^RT @\w+:\s*/i, "")    // skip retweets
      .replace(/https?:\/\/\S+/g, "")  // remove links
      .replace(/\s+/g, " ")
      .trim();

    if (!title || title.length < 15) continue;

    const pubDate = dateMatch ? new Date(dateMatch[1]) : new Date(0);
    const ageH    = (Date.now() - pubDate.getTime()) / 3600000;

    // Only keep tweets from last 72h
    if (ageH > 72) continue;

    items.push({ account, text: title, ageH: Math.round(ageH) });
  }

  return items;
}

async function fetchAccountTweets(account) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const xml = await fetchUrl(instance, `/${account}/rss`);
      if (!xml.includes("<rss")) continue;
      const tweets = parseRSS(xml, account);
      if (tweets.length) return tweets;
    } catch {}
  }
  return [];
}

async function getRecentContext() {
  const allTweets = [];

  await Promise.all(ACCOUNTS.map(async (account) => {
    try {
      const tweets = await fetchAccountTweets(account);
      allTweets.push(...tweets.slice(0, 3)); // max 3 per account
    } catch (e) {
      console.error(`[news] failed to fetch @${account}:`, e.message);
    }
  }));

  if (!allTweets.length) return null;

  // Sort by recency
  allTweets.sort((a, b) => a.ageH - b.ageH);

  // Format as context string for the prompt
  const lines = allTweets.slice(0, 10).map(t => `- @${t.account} (${t.ageH}h ago): "${t.text}"`);
  return `Recent CX/Kick community posts (last 72h):\n${lines.join("\n")}`;
}

module.exports = { getRecentContext };
