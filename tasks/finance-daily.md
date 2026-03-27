# Financial AI Daily News

Financial AI Daily News pipeline:

1. Run `agentbridge-rss` to fetch today's financial AI news from RSS feeds. Read the results from ~/.agentbridge/finance/rss-{today}.json.

2. Read today's AI news report from ~/.agentbridge/reports/AI-Daily-{today}.md — cross-reference with the RSS data. Stories that appear in both sources are higher signal.

3. Analyze and rank stories by market impact. Prioritize: major earnings surprises, M&A activity, regulatory changes, breakthrough announcements, and significant funding rounds involving AI companies.

4. Write the report to ~/.agentbridge/reports/Finance-AI-Daily-{today}.md with sections: Top Stories, Watchlist Movers, Regulatory/Policy, Funding & Deals.

5. Review tickers mentioned in today's news. If any relevant ticker is NOT in ~/.agentbridge/finance/stock_watchlist.md under ## Active, append it under ## Proposed with a one-line reason and today's date.

## Definition of Done
- ~/.agentbridge/reports/Finance-AI-Daily-{today}.md
