/**
 * abtars-rss — fetch RSS/Atom feeds, output JSON
 *
 * Usage:
 *   abtars-rss --feeds <path>           # fetch feeds from JSON file
 *   abtars-rss --feeds <path> --hours 48
 *
 * Reads:  a feeds.json file (array of {url, name, keywords?})
 * Writes: ~/.abtars/workspace/rss/<feedname>/<date>.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { abtarsHome } from "../paths.js";

interface FeedConfig {
  url: string;
  name: string;
  keywords?: string[];
}

interface RssItem {
  title: string;
  link: string;
  summary: string;
  date: string;
  source: string;
}

const UA = "abtars-rss/1.0";

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, "i"));
  return m?.[1]?.trim() ?? "";
}

function attrHref(xml: string): string {
  const m = xml.match(/<link[^>]+href="([^"]+)"/i);
  return m?.[1] ?? "";
}

function parseXmlFeed(xml: string, source: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const c = m[1] ?? "";
    items.push({ title: tag(c, "title"), link: tag(c, "link") || attrHref(c), summary: tag(c, "description").replace(/<[^>]+>/g, "").slice(0, 300), date: tag(c, "pubDate"), source });
  }
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const c = m[1] ?? "";
    items.push({ title: tag(c, "title"), link: attrHref(c) || tag(c, "link"), summary: (tag(c, "summary") || tag(c, "content")).replace(/<[^>]+>/g, "").slice(0, 300), date: tag(c, "updated") || tag(c, "published"), source });
  }
  return items;
}

function parseEdgarJson(json: string, source: string): RssItem[] {
  try {
    const data = JSON.parse(json);
    return (data.hits?.hits ?? []).map((h: any) => ({
      title: h._source?.display_names?.join(", ") + " — " + h._source?.form_type,
      link: `https://www.sec.gov/Archives/edgar/data/${h._source?.entity_id}/${h._source?.file_num}`,
      summary: (h._source?.file_description ?? "").slice(0, 300),
      date: h._source?.file_date ?? "",
      source,
    }));
  } catch { return []; }
}

async function fetchFeed(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function filterByAge(items: RssItem[], hours: number): RssItem[] {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return items.filter((item) => {
    if (!item.date) return true;
    const ts = new Date(item.date).getTime();
    return isNaN(ts) || ts > cutoff;
  });
}

function filterByKeywords(items: RssItem[], keywords: string[]): RssItem[] {
  if (keywords.length === 0) return items;
  const lower = keywords.map((k) => k.toLowerCase());
  return items.filter((item) => {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    return lower.some((kw) => text.includes(kw));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const feedsIdx = args.indexOf("--feeds");
  if (feedsIdx === -1 || !args[feedsIdx + 1]) {
    console.error("Usage: abtars-rss --feeds <path.json> [--hours N]");
    process.exit(1);
  }
  const feedsPath = args[feedsIdx + 1]!;
  const hours = parseInt(args.find((_, i, a) => a[i - 1] === "--hours") ?? "24", 10);

  const feeds: FeedConfig[] = JSON.parse(readFileSync(feedsPath, "utf-8"));
  const outDir = join(abtarsHome(), "workspace", "rss");

  console.error(`Fetching ${feeds.length} feeds...`);

  const allItems: RssItem[] = [];
  for (const feed of feeds) {
    try {
      console.error(`  ${feed.name}...`);
      const body = await fetchFeed(feed.url);
      let items = body.trimStart().startsWith("{") ? parseEdgarJson(body, feed.name) : parseXmlFeed(body, feed.name);
      if (feed.keywords) items = filterByKeywords(items, feed.keywords);
      allItems.push(...items);
    } catch (e: any) {
      console.error(`  ⚠ ${feed.name} failed: ${e.message}`);
    }
  }

  const filtered = filterByAge(allItems, hours);
  const seen = new Set<string>();
  const deduped = filtered.filter((item) => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const date = new Date().toISOString().slice(0, 10);
  const feedName = basename(feedsPath, ".json").replace(/_feeds$/, "");
  const feedOutDir = join(outDir, feedName);
  mkdirSync(feedOutDir, { recursive: true });
  const outFile = join(feedOutDir, `${date}.json`);
  const payload = { date, hours, totalFeeds: feeds.length, totalItems: deduped.length, items: deduped };
  writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf-8");

  console.error(`📄 ${deduped.length} items → ${outFile}`);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => { console.error(`Fatal: ${err.message}`); process.exit(1); });

// Hard 60s process timeout — prevents hanging indefinitely on slow feeds
setTimeout(() => { console.error("Timeout: 60s exceeded"); process.exit(1); }, 60_000).unref();
