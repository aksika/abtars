#!/usr/bin/env node
/**
 * agentbridge-tweet — CLI for fetching tweets via rettiwt-api + FxTwitter.
 *
 * Usage:
 *   agentbridge-tweet --fetch <tweet-url>              # single tweet via FxTwitter
 *   agentbridge-tweet --timeline <handle> [--count N]  # user timeline (guest auth)
 *   agentbridge-tweet --feed [--format md]             # all followed handles → ranked output
 *   agentbridge-tweet --feed --discover                # feed + reply analysis for new follows
 *   agentbridge-tweet --replies <tweet-id>             # replies on a tweet (user auth)
 *   agentbridge-tweet --search "query"                 # search X (user auth)
 *   agentbridge-tweet --user <handle>                  # user profile info
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { agentBridgeHome, reportsDir } from "../paths.js";
import { localDate } from "../components/env-utils.js";

const AB_HOME = agentBridgeHome();
const TWITTER_DIR = join(AB_HOME, "twitterX");
const COOKIE_PATH = join(AB_HOME, "secret", "cookies", "x-cookies.json");
const BASE_FOLLOWS = join(TWITTER_DIR, "base.follows.json");
const MOLTY_FOLLOWS = join(TWITTER_DIR, "molty.follows.json");
const REPORTS_DIR = reportsDir("x");
const OUTPUT_DIR = join(TWITTER_DIR, "output");

/**
 * Send a file to the Telegram main chat via Bot API (standalone — no bridge dep).
 * No-op if bot token or chat id env vars are missing.
 */
async function sendReportToTelegram(filePath: string, caption: string): Promise<void> {
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

// ── Types ──────────────────────────────────────────────────────────────────

interface FollowEntry {
  handle: string;
  name?: string;
  role?: string;
  category?: string;
  why?: string;
}

interface FollowsFile {
  handles?: string[];
  entries?: FollowEntry[];
  settings?: {
    max_tweets_per_handle?: number;
    min_likes_for_highlight?: number;
    newsletter_top_n?: number;
  };
}

interface RankedTweet {
  id: string;
  text: string;
  author: string;
  handle: string;
  likes: number;
  retweets: number;
  views: number | null;
  createdAt: string;
  score: number;
}

interface DiscoverCandidate {
  handle: string;
  name: string;
  bio: string;
  followers: number;
  foundVia: string;       // "reply on @handle's tweet about X"
  replyLikes: number;
  replyText: string;
}

const AI_BIO_KEYWORDS = /\b(ai|ml|llm|machine.?learning|deep.?learning|neural|nlp|computer.?vision|reinforcement|transformer|diffusion|robotics|research|phd|professor|scientist)\b/i;

// ── Cookie → API Key ───────────────────────────────────────────────────────

export function loadApiKey(): string | undefined {
  if (!existsSync(COOKIE_PATH)) return undefined;
  try {
    const raw = readFileSync(COOKIE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const cookieStr = Object.entries(parsed)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ") + ";";
    return Buffer.from(cookieStr).toString("base64");
  } catch {
    return undefined;
  }
}

// ── Follow list loading ────────────────────────────────────────────────────

function loadFollows(): string[] {
  const handles = new Set<string>();

  for (const path of [BASE_FOLLOWS, MOLTY_FOLLOWS]) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as FollowsFile | FollowEntry[];
      if (Array.isArray(raw)) {
        raw.forEach((e) => handles.add(e.handle.replace(/^@/, "").toLowerCase()));
      } else {
        raw.handles?.forEach((h) => handles.add(h.replace(/^@/, "").toLowerCase()));
        raw.entries?.forEach((e) => handles.add(e.handle.replace(/^@/, "").toLowerCase()));
      }
    } catch { /* skip malformed */ }
  }
  return [...handles];
}

// ── FxTwitter fetch ────────────────────────────────────────────────────────

async function fetchTweet(url: string): Promise<void> {
  const match = url.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
  if (!match) {
    console.error("Invalid tweet URL. Expected: https://x.com/user/status/123");
    process.exit(1);
  }
  const [, user, id] = match;
  const res = await fetch(`https://api.fxtwitter.com/${user}/status/${id}`);
  const data = await res.json() as any;
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
    media: t.media,
  }, null, 2));
}

// ── User profile ───────────────────────────────────────────────────────────

async function fetchUser(handle: string): Promise<void> {
  const { Rettiwt } = await import("rettiwt-api");
  const r = new Rettiwt();
  const d = await r.user.details(handle.replace(/^@/, ""));
  if (!d) { console.error("User not found"); process.exit(1); }
  console.log(JSON.stringify(d.toJSON(), null, 2));
}

// ── Timeline ───────────────────────────────────────────────────────────────

const GQL_USER_TWEETS = "https://x.com/i/api/graphql/E3opETHurmVJflFsUBVuUQ/UserTweets";

async function fetchTimeline(handle: string, count: number): Promise<RankedTweet[]> {
  const { Rettiwt } = await import("rettiwt-api");
  const r = new Rettiwt();
  const clean = handle.replace(/^@/, "");

  const user = await r.user.details(clean);
  if (!user) throw new Error(`User @${clean} not found`);

  // Try chronological GraphQL (cookie auth) first, fall back to guest
  const auth = loadCookieHeader();
  if (auth) {
    try {
      return await fetchTimelineGql(user.id, user.fullName ?? clean, clean, count);
    } catch { /* fall through to guest */ }
  }

  // Guest fallback (returns by engagement, not chronological)
  const data = await r.user.timeline(user.id, count);
  return data.list.map((t: any) => {
    const j = t.toJSON();
    const likes = j.likeCount ?? 0;
    const retweets = j.retweetCount ?? 0;
    const views = j.viewCount ?? 0;
    return {
      id: j.id, text: j.fullText ?? "", author: user.fullName ?? clean, handle: clean,
      likes, retweets, views, createdAt: j.createdAt,
      score: likes + retweets * 3 + (views ? views / 1000 : 0),
    };
  });
}

async function fetchTimelineGql(userId: string, authorName: string, handle: string, count: number): Promise<RankedTweet[]> {
  const data = await twitterGql(GQL_USER_TWEETS, {
    userId, count, includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true, withVoice: true, withV2Timeline: true,
  });
  const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [];
  const entries = instructions.find((i: any) => i.type === "TimelineAddEntries")?.entries ?? [];
  const tweets: RankedTweet[] = [];
  for (const e of entries) {
    const tw = e.content?.itemContent?.tweet_results?.result;
    if (!tw?.legacy) continue;
    const p = parseTweetResult(tw);
    const likes = p.likes, retweets = p.retweets, views = p.views;
    tweets.push({
      id: p.id, text: p.text, author: p.name || authorName, handle: p.handle || handle,
      likes, retweets, views, createdAt: p.createdAt,
      score: likes + retweets * 3 + (views ? views / 1000 : 0),
    });
  }
  return tweets;
}

// ── Feed (all follows) ────────────────────────────────────────────────────

async function runFeed(format: "json" | "md", count: number, topN: number, discover: boolean, outputPath?: string): Promise<void> {
  const handles = loadFollows();
  if (handles.length === 0) {
    console.error("No follows found. Create ~/.agentbridge/twitterX/base.follows.json or molty.follows.json");
    process.exit(1);
  }

  console.error(`Fetching timelines for ${handles.length} handles...`);
  const allTweets: RankedTweet[] = [];

  for (const h of handles) {
    try {
      console.error(`  @${h}...`);
      const tweets = await fetchTimeline(h, count);
      // Filter to last 24h
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = tweets.filter((t) => new Date(t.createdAt).getTime() > cutoff);
      allTweets.push(...recent);
    } catch (e: any) {
      console.error(`  ⚠ @${h} failed: ${e.message}`);
    }
  }

  // Rank by score
  allTweets.sort((a, b) => b.score - a.score);
  const top = allTweets.slice(0, topN);

  // Discovery: analyze replies on top tweets
  let candidates: DiscoverCandidate[] = [];
  if (discover && top.length > 0) {
    candidates = await runDiscover(top.slice(0, 5), handles);
  }

  // Write raw JSON output (default behavior)
  const date = localDate();
  const outFile = outputPath ?? join(OUTPUT_DIR, `tweets-${date}.json`);
  mkdirSync(join(outFile, ".."), { recursive: true });
  const payload = { date, source: "agentbridge-tweet", totalCollected: allTweets.length, tweets: top, discover: candidates };
  writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.error(`📄 ${top.length} tweets written to ${outFile}`);

  // Optional: also render newsletter markdown
  if (format === "md") {
    const md = renderNewsletter(top, candidates, date);
    mkdirSync(REPORTS_DIR, { recursive: true });
    const reportPath = join(REPORTS_DIR, `AI-Daily-${date}.md`);
    writeFileSync(reportPath, md, "utf8");
    console.error(`📰 Newsletter written to ${reportPath}`);
    await sendReportToTelegram(reportPath, `AI Daily ${date}`).catch((err) => {
      console.error(`⚠ Telegram send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// ── Direct Twitter GraphQL (user auth, bypasses rettiwt-api TID issue) ────

const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const GQL_TWEET_DETAIL = "https://x.com/i/api/graphql/97JF30KziU00483E_8elBA/TweetDetail";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GQL_FEATURES: Record<string, boolean> = {
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
  responsive_web_enhance_cards_enabled: false,
};

function loadCookieHeader(): { cookie: string; csrf: string } | undefined {
  if (!existsSync(COOKIE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(COOKIE_PATH, "utf8"));
    const cookie = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join("; ");
    return { cookie, csrf: parsed.ct0 };
  } catch { return undefined; }
}

async function twitterGql(url: string, variables: Record<string, any>): Promise<any> {
  const auth = loadCookieHeader();
  if (!auth) throw new Error("User auth required. Refresh cookies in ~/.agentbridge/secret/cookies/x-cookies.json");

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GQL_FEATURES),
  });
  const res = await fetch(`${url}?${params}`, {
    headers: {
      authorization: `Bearer ${BEARER}`,
      "x-csrf-token": auth.csrf,
      cookie: auth.cookie,
      "user-agent": UA,
    },
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error("403 — cookies may be expired. Refresh in ~/.agentbridge/secret/cookies/x-cookies.json");
    throw new Error(`Twitter API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

// ── Replies (user auth, direct GraphQL) ───────────────────────────────────

function extractTweetsFromTimeline(data: any): any[] {
  const entries: any[] = [];
  const instructions = data?.data?.tweetResult?.result?.timeline?.instructions
    ?? data?.data?.threaded_conversation_with_injections_v2?.instructions
    ?? data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions
    ?? [];
  for (const inst of instructions) {
    for (const entry of inst.entries ?? []) {
      const tweet = entry.content?.itemContent?.tweet_results?.result
        ?? entry.content?.items?.[0]?.item?.itemContent?.tweet_results?.result;
      if (tweet?.legacy) entries.push(tweet);
      // Conversation thread items
      for (const item of entry.content?.items ?? []) {
        const t = item.item?.itemContent?.tweet_results?.result;
        if (t?.legacy) entries.push(t);
      }
    }
  }
  return entries;
}

function parseTweetResult(t: any): { id: string; handle: string; name: string; text: string; likes: number; retweets: number; views: number; createdAt: string } {
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
    createdAt: legacy.created_at ?? "",
  };
}

async function fetchReplies(tweetId: string, minLikes: number): Promise<void> {
  const data = await twitterGql(GQL_TWEET_DETAIL, {
    focalTweetId: tweetId,
    with_rux_injections: false,
    rankingMode: "Relevance",
    includePromotedContent: false,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
  });

  const all = extractTweetsFromTimeline(data);
  // Deduplicate by tweet ID, skip the focal tweet itself
  const seen = new Set<string>();
  const replies = all
    .map(parseTweetResult)
    .filter((t) => {
      if (t.id === tweetId || seen.has(t.id) || t.likes < minLikes) return false;
      seen.add(t.id);
      return true;
    })
    .sort((a, b) => b.likes - a.likes);

  console.log(JSON.stringify(replies, null, 2));
}

// ── Search (fallback: web search, X search is locked down) ───────────────

async function searchTweets(_query: string, _count: number): Promise<void> {
  // X's GraphQL search endpoints require x-client-transaction-id (browser-only).
  // Adaptive search returns empty bodies. Fall back to guest timeline search.
  console.error("⚠ Direct X search is restricted. Use --timeline per handle or web search for discovery.");
  console.error("  Tip: agentbridge-tweet --replies <tweet-id> works for finding interesting commenters.");
  process.exit(1);
}

// ── Discover (reply analysis) ─────────────────────────────────────────────

async function runDiscover(topTweets: RankedTweet[], knownHandles: string[]): Promise<DiscoverCandidate[]> {
  const auth = loadCookieHeader();
  if (!auth) {
    console.error("  ⚠ Skipping discovery — user auth required. Refresh cookies.");
    return [];
  }

  const { Rettiwt } = await import("rettiwt-api");
  const guestRettiwt = new Rettiwt(); // guest for profile lookups
  const known = new Set(knownHandles.map((h) => h.toLowerCase()));
  const candidates: DiscoverCandidate[] = [];
  const seen = new Set<string>();

  console.error(`\n🔍 Discovering new follows from top ${topTweets.length} tweets...`);

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
        withVoice: true,
      });

      const all = extractTweetsFromTimeline(data);
      const goodReplies = all
        .map(parseTweetResult)
        .filter((t) => t.id !== tweet.id && t.likes >= 50)
        .sort((a, b) => b.likes - a.likes)
        .slice(0, 5);

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
            replyText: reply.text.slice(0, 200),
          });
        } catch { /* skip */ }
      }
    } catch (e: any) {
      console.error(`  ⚠ Replies failed for ${tweet.id}: ${e.message}`);
    }
  }

  console.error(`  Found ${candidates.length} candidates`);
  return candidates.sort((a, b) => b.replyLikes - a.replyLikes);
}

function renderNewsletter(tweets: RankedTweet[], candidates: DiscoverCandidate[], date: string): string {
  const lines: string[] = [`# AI Daily Brief — ${date}\n`];

  if (tweets.length === 0) {
    lines.push("No tweets found in the last 24 hours from followed accounts.\n");
    return lines.join("\n");
  }

  lines.push("## 🔥 Top Tweets (by engagement)\n");
  tweets.forEach((t, i) => {
    const text = t.text.length > 280 ? t.text.slice(0, 277) + "..." : t.text;
    lines.push(`### ${i + 1}. @${t.handle} — ${t.author}`);
    lines.push(`- **Likes:** ${t.likes} | **Retweets:** ${t.retweets} | **Views:** ${t.views ?? "N/A"}`);
    lines.push(`- ${text.replace(/\n/g, " ")}`);
    lines.push(`- 🔗 https://x.com/${t.handle}/status/${t.id}\n`);
  });

  if (candidates.length > 0) {
    lines.push("## 👤 Discover — New Follows\n");
    candidates.forEach((c) => {
      lines.push(`### @${c.handle} — ${c.name}`);
      lines.push(`- **Bio:** ${c.bio.slice(0, 200)}`);
      lines.push(`- **Followers:** ${c.followers.toLocaleString()}`);
      lines.push(`- **Found via:** ${c.foundVia}`);
      lines.push(`- **Their reply** (${c.replyLikes} likes): ${c.replyText.replace(/\n/g, " ")}\n`);
    });
  }

  lines.push("## 📊 Signals & Trends\n");
  lines.push("_(To be filled by sleep cycle analysis)_\n");
  lines.push(`---\n*Auto-generated via agentbridge-tweet. Sources: X (via rettiwt-api).*\n`);
  return lines.join("\n");
}

// ── Arg parsing & main ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let command: "fetch" | "timeline" | "feed" | "user" | "replies" | "search" = "feed";
  let target = "";
  let count = 20;
  let topN = 12;
  let format: "json" | "md" = "md";
  let discover = false;
  let minLikes = 50;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--fetch": command = "fetch"; target = args[++i] ?? ""; break;
      case "--timeline": command = "timeline"; target = args[++i] ?? ""; break;
      case "--user": command = "user"; target = args[++i] ?? ""; break;
      case "--feed": command = "feed"; break;
      case "--replies": command = "replies"; target = args[++i] ?? ""; break;
      case "--search": command = "search"; target = args[++i] ?? ""; break;
      case "--discover": discover = true; break;
      case "--count": count = parseInt(args[++i] ?? "20", 10); break;
      case "--top": topN = parseInt(args[++i] ?? "12", 10); break;
      case "--min-likes": minLikes = parseInt(args[++i] ?? "50", 10); break;
      case "--format": format = (args[++i] ?? "md") as "json" | "md"; break;
      case "--output": output = args[++i] ?? ""; break;
    }
  }
  return { command, target, count, topN, format, discover, minLikes, output };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(`agentbridge-tweet — fetch tweets via rettiwt-api + FxTwitter.

Usage:
  agentbridge-tweet --fetch <tweet-url>              # single tweet via FxTwitter
  agentbridge-tweet --timeline <handle> [--count N]  # user timeline
  agentbridge-tweet --feed [--format md]             # all followed handles → ranked output
  agentbridge-tweet --feed --discover                # feed + reply analysis for new follows
  agentbridge-tweet --replies <tweet-id>             # replies on a tweet
  agentbridge-tweet --search "query"                 # search X
  agentbridge-tweet --user <handle>                  # user profile info`);
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
