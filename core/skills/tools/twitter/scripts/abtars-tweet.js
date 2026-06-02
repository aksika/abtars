#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
function abtarsHome() {
  return process.env.ABTARS_HOME ?? join(homedir(), ".abtars");
}
function reportsDir(cat) {
  return join(abtarsHome(), "reports", cat);
}
function localDate() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function logAndSwallow(_tag, _ctx, _err) {
  return void 0;
}
import { join, basename } from "node:path";
const AB_HOME = abtarsHome();
const TWITTER_DIR = join(AB_HOME, "workspace", "twitterX");
const COOKIE_PATH = join(AB_HOME, "secret", "cookies", "x-cookies.json");
const BASE_FOLLOWS = join(TWITTER_DIR, process.env["TWEET_BASE_FOLLOWS_FILE"] ?? "base.follows.json");
const AGENT_FOLLOWS = join(TWITTER_DIR, process.env["TWEET_FOLLOWS_FILE"] ?? "agent.follows.json");
const REPORTS_DIR = reportsDir("x");
const OUTPUT_DIR = join(TWITTER_DIR, "output");
async function sendReportToTelegram(filePath, caption) {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["AGENTBRIDGE_MAIN_CHAT_ID"];
  if (!token || !chatId) return;
  if (!existsSync(filePath)) return;
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append("chat_id", chatId);
  const blob = new Blob([buf], { type: "text/markdown" });
  form.append("document", blob, basename(filePath));
  form.append("caption", caption.slice(0, 1024));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Telegram sendDocument failed (${res.status}): ${text}`);
  }
}
const AI_BIO_KEYWORDS = /\b(ai|ml|llm|machine.?learning|deep.?learning|neural|nlp|computer.?vision|reinforcement|transformer|diffusion|robotics|research|phd|professor|scientist)\b/i;
function loadApiKey() {
  if (!existsSync(COOKIE_PATH)) return void 0;
  try {
    const raw = readFileSync(COOKIE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const cookieStr = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join("; ") + ";";
    return Buffer.from(cookieStr).toString("base64");
  } catch {
    return void 0;
  }
}
function loadFollows() {
  const handles = /* @__PURE__ */ new Set();
  for (const path of [BASE_FOLLOWS, AGENT_FOLLOWS]) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(raw)) {
        raw.forEach((e) => handles.add(e.handle.replace(/^@/, "").toLowerCase()));
      } else {
        raw.handles?.forEach((h) => handles.add(h.replace(/^@/, "").toLowerCase()));
        raw.entries?.forEach((e) => handles.add(e.handle.replace(/^@/, "").toLowerCase()));
      }
    } catch (err) {
      logAndSwallow("abtars_tweet", "op", err);
    }
  }
  return [...handles];
}
async function fetchTweet(url) {
  const match = url.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
  if (!match) {
    console.error("Invalid tweet URL. Expected: https://x.com/user/status/123");
    process.exit(1);
  }
  const [, user, id] = match;
  const res = await fetch(`https://api.fxtwitter.com/${user}/status/${id}`);
  const data = await res.json();
  if (data.code !== 200) {
    console.error(`FxTwitter error: ${data.message}`);
    process.exit(1);
  }
  const t = data.tweet;
  console.log(JSON.stringify({
    id: t.id,
    author: t.author?.name,
    handle: t.author?.screen_name,
    text: t.text,
    likes: t.likes,
    retweets: t.retweets,
    replies: t.replies,
    views: t.views,
    created_at: t.created_at,
    media: t.media
  }, null, 2));
}
async function loadRettiwt() {
  try {
    return await import("rettiwt-api");
  } catch {
    console.error("rettiwt-api not installed. Run: npm install rettiwt-api");
    process.exit(1);
  }
}
async function fetchUser(handle) {
  const { Rettiwt } = await loadRettiwt();
  const r = new Rettiwt();
  const d = await r.user.details(handle.replace(/^@/, ""));
  if (!d) {
    console.error("User not found");
    process.exit(1);
  }
  console.log(JSON.stringify(d.toJSON(), null, 2));
}
const GQL_USER_TWEETS = "https://x.com/i/api/graphql/E3opETHurmVJflFsUBVuUQ/UserTweets";
async function fetchTimeline(handle, count) {
  const { Rettiwt } = await loadRettiwt();
  const r = new Rettiwt();
  const clean = handle.replace(/^@/, "");
  const user = await r.user.details(clean);
  if (!user) throw new Error(`User @${clean} not found`);
  const auth = loadCookieHeader();
  if (auth) {
    try {
      return await fetchTimelineGql(user.id, user.fullName ?? clean, clean, count);
    } catch (err) {
      logAndSwallow("abtars_tweet", "op", err);
    }
  }
  const data = await r.user.timeline(user.id, count);
  return data.list.map((t) => {
    const j = t.toJSON();
    const likes = j.likeCount ?? 0;
    const retweets = j.retweetCount ?? 0;
    const views = j.viewCount ?? 0;
    return {
      id: j.id,
      text: j.fullText ?? "",
      author: user.fullName ?? clean,
      handle: clean,
      likes,
      retweets,
      views,
      createdAt: j.createdAt,
      score: likes + retweets * 3 + (views ? views / 1e3 : 0)
    };
  });
}
async function fetchTimelineGql(userId, authorName, handle, count) {
  const data = await twitterGql(GQL_USER_TWEETS, {
    userId,
    count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true
  });
  const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [];
  const entries = instructions.find((i) => i.type === "TimelineAddEntries")?.entries ?? [];
  const tweets = [];
  for (const e of entries) {
    const tw = e.content?.itemContent?.tweet_results?.result;
    if (!tw?.legacy) continue;
    const p = parseTweetResult(tw);
    const likes = p.likes, retweets = p.retweets, views = p.views;
    tweets.push({
      id: p.id,
      text: p.text,
      author: p.name || authorName,
      handle: p.handle || handle,
      likes,
      retweets,
      views,
      createdAt: p.createdAt,
      score: likes + retweets * 3 + (views ? views / 1e3 : 0)
    });
  }
  return tweets;
}
async function runFeed(format, count, topN, discover, outputPath) {
  const handles = loadFollows();
  if (handles.length === 0) {
    console.error("No follows found. Create ~/.abtars/workspace/twitterX/base.follows.json or agent.follows.json");
    process.exit(1);
  }
  console.error(`Fetching timelines for ${handles.length} handles...`);
  const allTweets = [];
  for (const h of handles) {
    try {
      console.error(`  @${h}...`);
      const tweets = await fetchTimeline(h, count);
      const cutoff = Date.now() - 24 * 60 * 60 * 1e3;
      const recent = tweets.filter((t) => new Date(t.createdAt).getTime() > cutoff);
      allTweets.push(...recent);
    } catch (e) {
      console.error(`  \u26A0 @${h} failed: ${e.message}`);
    }
  }
  allTweets.sort((a, b) => b.score - a.score);
  const top = allTweets.slice(0, topN);
  let candidates = [];
  if (discover && top.length > 0) {
    candidates = await runDiscover(top.slice(0, 5), handles);
  }
  const date = localDate();
  const outFile = outputPath ?? join(OUTPUT_DIR, `tweets-${date}.json`);
  mkdirSync(join(outFile, ".."), { recursive: true });
  const payload = { date, source: "abtars-tweet", totalCollected: allTweets.length, tweets: top, discover: candidates };
  writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.error(`\u{1F4C4} ${top.length} tweets written to ${outFile}`);
  if (format === "md") {
    const md = renderNewsletter(top, candidates, date);
    mkdirSync(REPORTS_DIR, { recursive: true });
    const reportPath = join(REPORTS_DIR, `AI-Daily-${date}.md`);
    writeFileSync(reportPath, md, "utf8");
    console.error(`\u{1F4F0} Newsletter written to ${reportPath}`);
    await sendReportToTelegram(reportPath, `AI Daily ${date}`).catch((err) => {
      console.error(`\u26A0 Telegram send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const GQL_TWEET_DETAIL = "https://x.com/i/api/graphql/97JF30KziU00483E_8elBA/TweetDetail";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GQL_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false
};
function loadCookieHeader() {
  if (!existsSync(COOKIE_PATH)) return void 0;
  try {
    const parsed = JSON.parse(readFileSync(COOKIE_PATH, "utf8"));
    const cookie = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join("; ");
    return { cookie, csrf: parsed.ct0 };
  } catch {
    return void 0;
  }
}
async function twitterGql(url, variables) {
  const auth = loadCookieHeader();
  if (!auth) throw new Error("User auth required. Refresh cookies in ~/.abtars/secret/cookies/x-cookies.json");
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GQL_FEATURES)
  });
  const res = await fetch(`${url}?${params}`, {
    headers: {
      authorization: `Bearer ${BEARER}`,
      "x-csrf-token": auth.csrf,
      cookie: auth.cookie,
      "user-agent": UA
    }
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error("403 \u2014 cookies may be expired. Refresh in ~/.abtars/secret/cookies/x-cookies.json");
    throw new Error(`Twitter API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}
function extractTweetsFromTimeline(data) {
  const entries = [];
  const instructions = data?.data?.tweetResult?.result?.timeline?.instructions ?? data?.data?.threaded_conversation_with_injections_v2?.instructions ?? data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
  for (const inst of instructions) {
    for (const entry of inst.entries ?? []) {
      const tweet = entry.content?.itemContent?.tweet_results?.result ?? entry.content?.items?.[0]?.item?.itemContent?.tweet_results?.result;
      if (tweet?.legacy) entries.push(tweet);
      for (const item of entry.content?.items ?? []) {
        const t = item.item?.itemContent?.tweet_results?.result;
        if (t?.legacy) entries.push(t);
      }
    }
  }
  return entries;
}
function parseTweetResult(t) {
  const legacy = t.legacy ?? {};
  const userResult = t.core?.user_results?.result ?? {};
  const userCore = userResult.core ?? {};
  const userLegacy = userResult.legacy ?? {};
  return {
    id: legacy.id_str ?? t.rest_id ?? "",
    handle: userCore.screen_name ?? userLegacy.screen_name ?? "",
    name: userCore.name ?? userLegacy.name ?? "",
    text: legacy.full_text ?? "",
    likes: legacy.favorite_count ?? 0,
    retweets: legacy.retweet_count ?? 0,
    views: parseInt(t.views?.count ?? "0", 10),
    createdAt: legacy.created_at ?? ""
  };
}
async function fetchReplies(tweetId, minLikes) {
  const data = await twitterGql(GQL_TWEET_DETAIL, {
    focalTweetId: tweetId,
    with_rux_injections: false,
    rankingMode: "Relevance",
    includePromotedContent: false,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true
  });
  const all = extractTweetsFromTimeline(data);
  const seen = /* @__PURE__ */ new Set();
  const replies = all.map(parseTweetResult).filter((t) => {
    if (t.id === tweetId || seen.has(t.id) || t.likes < minLikes) return false;
    seen.add(t.id);
    return true;
  }).sort((a, b) => b.likes - a.likes);
  console.log(JSON.stringify(replies, null, 2));
}
async function searchTweets(_query, _count) {
  console.error("\u26A0 Direct X search is restricted. Use --timeline per handle or web search for discovery.");
  console.error("  Tip: abtars-tweet --replies <tweet-id> works for finding interesting commenters.");
  process.exit(1);
}
async function runDiscover(topTweets, knownHandles) {
  const auth = loadCookieHeader();
  if (!auth) {
    console.error("  \u26A0 Skipping discovery \u2014 user auth required. Refresh cookies.");
    return [];
  }
  const { Rettiwt } = await loadRettiwt();
  const guestRettiwt = new Rettiwt();
  const known = new Set(knownHandles.map((h) => h.toLowerCase()));
  const candidates = [];
  const seen = /* @__PURE__ */ new Set();
  console.error(`
\u{1F50D} Discovering new follows from top ${topTweets.length} tweets...`);
  for (const tweet of topTweets) {
    try {
      console.error(`  Checking replies on @${tweet.handle}/${tweet.id}...`);
      const data = await twitterGql(GQL_TWEET_DETAIL, {
        focalTweetId: tweet.id,
        with_rux_injections: false,
        rankingMode: "Relevance",
        includePromotedContent: false,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withVoice: true
      });
      const all = extractTweetsFromTimeline(data);
      const goodReplies = all.map(parseTweetResult).filter((t) => t.id !== tweet.id && t.likes >= 50).sort((a, b) => b.likes - a.likes).slice(0, 5);
      for (const reply of goodReplies) {
        const rHandle = reply.handle.toLowerCase();
        if (!rHandle || known.has(rHandle) || seen.has(rHandle)) continue;
        seen.add(rHandle);
        try {
          const profile = await guestRettiwt.user.details(rHandle);
          if (!profile) continue;
          const pj = profile.toJSON();
          const bio = pj.description ?? "";
          if (!AI_BIO_KEYWORDS.test(bio)) continue;
          candidates.push({
            handle: rHandle,
            name: pj.fullName ?? rHandle,
            bio,
            followers: pj.followersCount ?? 0,
            foundVia: `reply on @${tweet.handle}'s tweet`,
            replyLikes: reply.likes,
            replyText: reply.text.slice(0, 200)
          });
        } catch (err) {
          logAndSwallow("abtars_tweet", "op", err);
        }
      }
    } catch (e) {
      console.error(`  \u26A0 Replies failed for ${tweet.id}: ${e.message}`);
    }
  }
  console.error(`  Found ${candidates.length} candidates`);
  return candidates.sort((a, b) => b.replyLikes - a.replyLikes);
}
function renderNewsletter(tweets, candidates, date) {
  const lines = [`# AI Daily Brief \u2014 ${date}
`];
  if (tweets.length === 0) {
    lines.push("No tweets found in the last 24 hours from followed accounts.\n");
    return lines.join("\n");
  }
  lines.push("## \u{1F525} Top Tweets (by engagement)\n");
  tweets.forEach((t, i) => {
    const text = t.text.length > 280 ? t.text.slice(0, 277) + "..." : t.text;
    lines.push(`### ${i + 1}. @${t.handle} \u2014 ${t.author}`);
    lines.push(`- **Likes:** ${t.likes} | **Retweets:** ${t.retweets} | **Views:** ${t.views ?? "N/A"}`);
    lines.push(`- ${text.replace(/\n/g, " ")}`);
    lines.push(`- \u{1F517} https://x.com/${t.handle}/status/${t.id}
`);
  });
  if (candidates.length > 0) {
    lines.push("## \u{1F464} Discover \u2014 New Follows\n");
    candidates.forEach((c) => {
      lines.push(`### @${c.handle} \u2014 ${c.name}`);
      lines.push(`- **Bio:** ${c.bio.slice(0, 200)}`);
      lines.push(`- **Followers:** ${c.followers.toLocaleString()}`);
      lines.push(`- **Found via:** ${c.foundVia}`);
      lines.push(`- **Their reply** (${c.replyLikes} likes): ${c.replyText.replace(/\n/g, " ")}
`);
    });
  }
  lines.push("## \u{1F4CA} Signals & Trends\n");
  lines.push("_(To be filled by sleep cycle analysis)_\n");
  lines.push(`---
*Auto-generated via abtars-tweet. Sources: X (via rettiwt-api).*
`);
  return lines.join("\n");
}
function parseArgs() {
  const args = process.argv.slice(2);
  let command = "feed";
  let target = "";
  let count = 20;
  let topN = 12;
  let format = "md";
  let discover = false;
  let minLikes = 50;
  let output;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--fetch":
        command = "fetch";
        target = args[++i] ?? "";
        break;
      case "--timeline":
        command = "timeline";
        target = args[++i] ?? "";
        break;
      case "--user":
        command = "user";
        target = args[++i] ?? "";
        break;
      case "--feed":
        command = "feed";
        break;
      case "--replies":
        command = "replies";
        target = args[++i] ?? "";
        break;
      case "--search":
        command = "search";
        target = args[++i] ?? "";
        break;
      case "--discover":
        discover = true;
        break;
      case "--count":
        count = parseInt(args[++i] ?? "20", 10);
        break;
      case "--top":
        topN = parseInt(args[++i] ?? "12", 10);
        break;
      case "--min-likes":
        minLikes = parseInt(args[++i] ?? "50", 10);
        break;
      case "--format":
        format = args[++i] ?? "md";
        break;
      case "--output":
        output = args[++i] ?? "";
        break;
    }
  }
  return { command, target, count, topN, format, discover, minLikes, output };
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log(`abtars-tweet \u2014 fetch tweets via rettiwt-api + FxTwitter.

Usage:
  abtars-tweet --fetch <tweet-url>              # single tweet via FxTwitter
  abtars-tweet --timeline <handle> [--count N]  # user timeline
  abtars-tweet --feed [--format md]             # all followed handles \u2192 ranked output
  abtars-tweet --feed --discover                # feed + reply analysis for new follows
  abtars-tweet --replies <tweet-id>             # replies on a tweet
  abtars-tweet --search "query"                 # search X
  abtars-tweet --user <handle>                  # user profile info`);
    process.exit(0);
  }
  const { command, target, count, topN, format, discover, minLikes, output } = parseArgs();
  switch (command) {
    case "fetch":
      await fetchTweet(target);
      break;
    case "user":
      await fetchUser(target);
      break;
    case "timeline": {
      const tweets = await fetchTimeline(target, count);
      console.log(JSON.stringify(tweets, null, 2));
      break;
    }
    case "replies":
      await fetchReplies(target, minLikes);
      break;
    case "search":
      await searchTweets(target, count);
      break;
    case "feed":
      await runFeed(format, count, topN, discover, output);
      break;
  }
}
main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
export {
  loadApiKey
};
