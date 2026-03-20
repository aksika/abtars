# Twitter Integration Plan — `agentbridge-tweet`

## Use Case

We follow major AI researchers and key players on X. We want their latest tweets aggregated into a daily newsletter, and at the same time discover new people worth following by checking highly-liked comments on those tweets.

The browse agent can't reliably scrape X, so we replace it with direct API calls:
- **rettiwt-api** (npm) for timelines, search, and replies
- **FxTwitter API** for single-tweet hydration (no auth, lightweight fallback)

## Architecture

```
follows.json ──► agentbridge-tweet --feed ──► rettiwt-api (guest) ──► timelines
                                           ──► rettiwt-api (user)  ──► replies → discover new people
                                           ──► rank by engagement
                                           ──► output newsletter markdown

cron (daily) ──► agentbridge-tweet --feed ──► ~/reports/AI-Daily-YYYY-MM-DD.md
```

## Follow List

Two levels, merged at runtime. Read fresh on every run (no caching).

### Level 1 — `base.follows.json`
`~/.agentbridge/twitter/base.follows.json`
Curated list of top AI researchers & key players. Created once via research prompt (see Bootstrap Prompt below), manually maintained afterward.

### Level 2 — `molty.follows.json`
`~/.agentbridge/twitter/molty.follows.json`
Pulled from the Molty X account's following list via rettiwt-api. Auto-refreshed periodically.

### Merge logic
At runtime: `base ∪ molty` (union, deduplicated by handle). Base takes priority for any per-handle settings.

Fallback: if both are missing/empty, fall back to the existing browse-based `~/research/AI-news-24h.md` prompt.

### Bootstrap Prompt (for agent to create base.follows.json)

```
Research and compile a list of the most influential AI/ML accounts on X (Twitter).

Target: 30-50 handles across these categories:
- AI lab leaders (OpenAI, Anthropic, Google DeepMind, Meta AI, xAI, Mistral)
- Top ML researchers (NeurIPS/ICML regulars, citation leaders)
- AI infrastructure people (GPU/compute, training infra, MLOps)
- AI investors & dealmakers (VCs focused on AI)
- Independent AI commentators with real technical depth

For each, provide:
- X handle (exact, verified)
- Full name
- Role / affiliation
- Category (researcher / lab_leader / infra / investor / commentator)
- Why they matter (1 sentence)

Output as JSON array:
[
  {
    "handle": "ylecun",
    "name": "Yann LeCun",
    "role": "Chief AI Scientist, Meta",
    "category": "lab_leader",
    "why": "Turing Award winner, shapes Meta's AI direction"
  }
]

Rules:
- Only include accounts that are actually active (posted in last 30 days)
- Verify handles exist — do not hallucinate
- Prefer accounts that post original insights over those that just retweet
- No crypto/web3 accounts, no hype influencers without technical substance
```

```json
{
  "handles": [
    "kaboroevich",
    "ylecun",
    "demaboris",
    "iaboroevich"
  ],
  "settings": {
    "max_tweets_per_handle": 20,
    "min_likes_for_highlight": 100,
    "min_likes_for_reply_discovery": 50,
    "newsletter_top_n": 12
  }
}
```

## CLI — `agentbridge-tweet`

| Flag | Auth | Description |
|------|------|-------------|
| `--timeline @handle` | guest | Fetch recent tweets from one handle |
| `--feed` | guest + user | Fetch all followed handles, rank, output newsletter |
| `--replies <tweet-id>` | user | Get replies, surface highly-liked commenters |
| `--fetch <tweet-url>` | none | Single tweet via FxTwitter API |
| `--search "query"` | user | Search X for matching tweets |
| `--discover` | user | Run reply analysis on top tweets, suggest new follows |

Output: JSON to stdout (for piping) or `--format md` for markdown.

## Auth

- **Guest** (no login): user timelines, user details, single tweet details
- **User** (cookies from `~/.agentbridge/titok/cookies/x-cookies.json`): search, replies, likes, advanced features
- Cookies converted to rettiwt-api API_KEY format at runtime
- On 401/403: KP sends Telegram alert "X cookies expired, please refresh"
- Cookie refresh: manual — copy fresh cookies when alerted (typically every few months)

## Newsletter Output

`~/reports/AI-Daily-YYYY-MM-DD.md`

```markdown
# AI Daily Brief — YYYY-MM-DD

## 🔥 Top Tweets (by engagement)
### 1. @handle — headline
- Likes: N | Retweets: N | Views: N
- Summary: tweet text (truncated)
- Link: https://x.com/...

## 👤 Discover — New Follows
### @commenter_handle — Name
- Found via: reply on @handle's tweet about X
- Their bio: ...
- Why: highly-liked reply with N likes, added real insight

## 📊 Signals & Trends
- Bullet list of patterns across today's tweets
```

## Implementation Stages

### Stage 0 — Auth & Bootstrap
- [ ] Read X cookies from `~/.agentbridge/titok/cookies/x-cookies.json` (already exists, 0600 perms)
- [ ] Convert cookies to rettiwt-api API_KEY format (base64-encoded)
- [ ] **Base list**: user gives bootstrap prompt to an agent → produces `base.follows.json`
- [ ] **Molty list**: `agentbridge-tweet --bootstrap-molty` → rettiwt-api pulls Molty account's following list → `molty.follows.json`
- [ ] Filter both by AI/research keywords in bio
- [ ] User reviews and trims base list

### Stage 1 — Foundation
- [ ] `npm install rettiwt-api`
- [ ] `src/cli/agentbridge-tweet.ts` — arg parsing, FxTwitter fetch (single tweet)
- [ ] `~/.agentbridge/twitter/follows.json` — initial follow list
- [ ] Wire into `package.json` bin

### Stage 2 — Timelines
- [ ] `--timeline @handle` — guest auth, fetch recent tweets
- [ ] `--feed` — iterate follows.json, fetch all timelines
- [ ] Rank by engagement (likes + retweets + views)
- [ ] Output top N as markdown newsletter

### Stage 3 — Discovery
- [ ] `RETTIWT_API_KEY` env var support
- [ ] `--replies <tweet-id>` — fetch replies, filter by likes
- [ ] `--discover` — auto-run on top tweets from `--feed`
- [ ] Suggest new handles, append to newsletter

### Stage 4 — Search & Cron
- [ ] `--search "query"` — keyword search on X
- [ ] Cron entry for daily `--feed --discover --format md`
- [ ] Replace or complement existing AI-news-24h browse task

### Stage 5 — Memory Integration (core, not optional)
- [ ] Each top tweet → `agentbridge-store` automatically after feed run
  - `classification=0` (UNCLASSIFIED — public tweet)
  - `trust=0` (untrusted — open web, prompt injection risk)
  - `integrity=2` (extracted — API-pulled, not direct user input)
  - `credibility` = derived from engagement + author verification (1-6 scale)
- [ ] Discovered people → store as memories ("AI researcher @handle works on X at Y")
- [ ] KP can recall tweets in conversation, sleep cycle connects dots across days
- [ ] Darwinism merges/compacts related tweets over time
- [ ] Newsletter markdown also written to `~/reports/` as human-readable artifact
