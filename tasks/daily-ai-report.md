# Daily AI Report

Daily AI News pipeline:

1. Run `agentbridge-tweet --feed --discover` to collect today's tweets. Read the results from ~/.agentbridge/twitterX/output/tweets-{today}.json.

2. Browse these sources for AI headlines from the past 24h:
   - techcrunch.com/category/artificial-intelligence
   - arstechnica.com/ai
   - theverge.com/ai-artificial-intelligence

3. Check Gmail for AI-related emails from the last 24h:
   - List recent emails: gws gmail users messages list --params '{"userId": "me", "q": "newer_than:1d (AI OR artificial intelligence OR LLM OR GPT OR machine learning)", "maxResults": 20}'
   - For each result, fetch the content: gws gmail users messages get --params '{"userId": "me", "id": "MESSAGE_ID"}'
   - After reading, mark each as read: gws gmail users messages modify --params '{"userId": "me", "id": "MESSAGE_ID"}' --json '{"removeLabelIds": ["UNREAD"]}'

4. Cross-reference all collected data (tweets + web sources + emails). Rank stories by impact — prioritize major launches, breakthroughs, funding rounds, and policy changes.

5. Write the final report to ~/.agentbridge/reports/AI-Daily-{today}.md.

## Definition of Done
- ~/.agentbridge/reports/AI-Daily-{today}.md
