---
name: rss
description: Fetch RSS/Atom feeds via abtars-rss CLI. Use when a task needs to pull news, articles, or structured feed data.
requires:
  bins: [abtars-rss]
---

# RSS Feed Fetcher

## Usage

```bash
abtars-rss --feeds <path-to-feeds.json> [--hours N]
```

- `--feeds` (required): path to a JSON file containing feed configs
- `--hours` (optional, default 24): only include items from the last N hours

## Feeds file format

```json
[
  { "url": "https://example.com/rss", "name": "Example Feed" },
  { "url": "https://other.com/atom.xml", "name": "Other Feed", "keywords": ["AI", "finance"] }
]
```

- `url`: RSS/Atom feed URL (or SEC EDGAR JSON endpoint)
- `name`: display name for the source
- `keywords` (optional): only keep items matching these keywords

## Output

Writes to `~/.abtars/workspace/rss/<feedname>/<date>.json` and prints JSON to stdout.

## Task integration

Place your feeds file alongside your task with the `_feeds.json` suffix:

```
tasks/
  daily-ai-report.md
  daily-ai-report_feeds.json    ← auto-injected into task context
```

In your task `.md`, instruct: "Run `abtars-rss --feeds tasks/daily-ai-report_feeds.json`"

## Do not

- Do not hardcode feed URLs in task instructions — put them in the `_feeds.json` file
- Do not parse HTML pages with this tool — it only handles RSS/Atom XML and SEC EDGAR JSON
