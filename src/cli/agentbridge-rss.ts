#!/usr/bin/env node
/**
 * agentbridge-rss — fetch RSS/Atom feeds, output JSON
 *
 * Usage:
 *   agentbridge-rss                          # fetch all feeds, output today's JSON
 *   agentbridge-rss --hours 48               # look back 48h instead of 24
 *
 * Reads:
 *   ~/.agentbridge/finance/feeds.json        # feed URLs + optional keyword filters
 *   ~/.agentbridge/finance/stock_watchlist.md # active tickers → Seeking Alpha RSS
 *
 * Writes:
 *   ~/.agentbridge/finance/rss-YYYY-MM-DD.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";
import { localDate } from "../components/env-utils.js";

const FINANCE_DIR = join(agentBridgeHome(), "finance");
const FEEDS_FILE = join(FINANCE_DIR, "feeds.json");
const WATCHLIST_FILE = join(FINANCE_DIR, "stock_watchlist.md");

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

const DEFAULT_FEEDS: FeedConfig[] = [
  {
    url: "https://news.google.com/rss/search?q=%22artificial+intelligence%22+AND+(%22earnings%22+OR+%22guidance%22+OR+%22stock%22+OR+%22funding%22)&hl=en-US&gl=US&ceid=US:en",
    name: "Google News AI Finance",
  },
  {
    url: "https://www.cnbc.com/id/19854910/device/rss/rss.html",
    name: "CNBC Technology",
  },
  {
    url: "https://www.cnbc.com/id/15839069/device/rss/rss.html",
    name: "CNBC Investing",
  },
  {
    url: "https://efts.sec.gov/LATEST/search-index?q=%22artificial+intelligence%22+OR+%22GPU%22+OR+%22machine+learning%22&forms=8-K&dateRange=custom&category=form-type",
    name: "SEC EDGAR 8-K AI",
    keywords: ["artificial intelligence", "AI", "GPU", "machine learning"],
  },
];

const UA = "AgentBridge-RSS/1.0";

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

  // RSS <item> elements
  const rssItems = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
  for (const m of rssItems) {
    const c = m[1] ?? "";
    items.push({
      title: tag(c, "title"),
      link: tag(c, "link") || attrHref(c),
      summary: tag(c, "description").replace(/<[^>]+>/g, "").slice(0, 300),
      date: tag(c, "pubDate"),
      source,
    });
  }

  // Atom <entry> elements
  const atomEntries = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi);
  for (const m of atomEntries) {
    const c = m[1] ?? "";
    items.push({
      title: tag(c, "title"),
      link: attrHref(c) || tag(c, "link"),
      summary: (tag(c, "summary") || tag(c, "content")).replace(/<[^>]+>/g, "").slice(0, 300),
      date: tag(c, "updated") || tag(c, "published"),
      source,
    });
  }

  return items;
}

function parseEdgarJson(json: string, source: string): RssItem[] {
  try {
    const data = JSON.parse(json);
    const hits = data.hits?.hits ?? [];
    return hits.map((h: any) => ({
      title: h._source?.display_names?.join(", ") + " — " + h._source?.form_type,
      link: `https://www.sec.gov/Archives/edgar/data/${h._source?.entity_id}/${h._source?.file_num}`,
      summary: (h._source?.file_description ?? "").slice(0, 300),
      date: h._source?.file_date ?? "",
      source,
    }));
  } catch {
    return [];
  }
}

async function fetchFeed(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function parseActiveTickers(): string[] {
  if (!existsSync(WATCHLIST_FILE)) return [];
  const content = readFileSync(WATCHLIST_FILE, "utf-8");
  const section = content.match(/## Active\n([\s\S]*?)(?=\n## |$)/);
  if (!section?.[1]) return [];
  const tickers: string[] = [];
  for (const line of section[1].split("\n")) {
    const m = line.match(/^- (\w+)/);
    if (m?.[1]) tickers.push(m[1]);
  }
  return tickers;
}

function filterByAge(items: RssItem[], hours: number): RssItem[] {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return items.filter((item) => {
    if (!item.date) return true; // keep items without dates
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
  if (process.argv.includes('--help')) {
    console.log(`agentbridge-rss — fetch RSS/Atom feeds, output JSON.

Usage:
  agentbridge-rss                          # fetch all feeds, output today's JSON
  agentbridge-rss --hours 48               # look back 48h instead of 24`);
    process.exit(0);
  }

  const hours = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--hours") ?? "24", 10);

  mkdirSync(FINANCE_DIR, { recursive: true });

  // Init feeds.json if missing
  if (!existsSync(FEEDS_FILE)) {
    writeFileSync(FEEDS_FILE, JSON.stringify(DEFAULT_FEEDS, null, 2), "utf-8");
    console.error(`Created default ${FEEDS_FILE}`);
  }

  const feeds: FeedConfig[] = JSON.parse(readFileSync(FEEDS_FILE, "utf-8"));

  // Add Seeking Alpha feeds for active tickers
  const tickers = parseActiveTickers();
  for (const t of tickers) {
    feeds.push({
      url: `https://seekingalpha.com/api/sa/combined/${t}.xml`,
      name: `SeekingAlpha:${t}`,
    });
  }

  console.error(`Fetching ${feeds.length} feeds (${tickers.length} tickers)...`);

  const allItems: RssItem[] = [];

  for (const feed of feeds) {
    try {
      console.error(`  ${feed.name}...`);
      const body = await fetchFeed(feed.url);

      let items: RssItem[];
      if (body.trimStart().startsWith("{")) {
        items = parseEdgarJson(body, feed.name);
      } else {
        items = parseXmlFeed(body, feed.name);
      }

      if (feed.keywords) items = filterByKeywords(items, feed.keywords);
      allItems.push(...items);
    } catch (e: any) {
      console.error(`  ⚠ ${feed.name} failed: ${e.message}`);
    }
  }

  const filtered = filterByAge(allItems, hours);

  // Dedup by title similarity
  const seen = new Set<string>();
  const deduped = filtered.filter((item) => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const date = localDate();
  const outFile = join(FINANCE_DIR, `rss-${date}.json`);
  const payload = { date, hours, totalFeeds: feeds.length, tickers, totalItems: deduped.length, items: deduped };
  writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf-8");

  console.error(`📄 ${deduped.length} items written to ${outFile}`);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
