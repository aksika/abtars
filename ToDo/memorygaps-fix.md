# Memory System Gaps and Fixes

## Current State

The design is solid. SQLite + FTS5 for fast search, filesystem for human-readable audit trail and rollup pipeline input. These are gaps and inconsistencies, not fundamental problems.

## Gap 1: Daily compactions not searched (web + memory-search-tool)

The web search controller and proactive recall filter L3 with tier IN (weekly, quarterly), skipping dailies. But agentbridge-recall (the agent CLI) searches ALL tiers including daily. Fix: include daily in the tier filter in memory-search-controller.ts:259 and memory-search-tool.ts:271. One-line fix each.

## Gap 2: Three different search implementations

agentbridge-recall, memory-search-tool.ts, and memory-search-controller.ts all do the same thing differently. The agent CLI is the most complete (has everything). Proactive recall is the weakest (no substring, no relaxed, no dailies, no original language). Fix: extract a shared search module, have all three call it.

## Gap 3: L4 original language requires separate parameter

L4 only fires when the caller passes an original param. The dashboard sends the same value for both keywords and original, so L4 is effectively broken for non-English queries on the dashboard. Fix: auto-detect non-ASCII in keywords and pass them as original too.

## Gap 4: Filesystem files never searched

working/ transcripts contain today pre-compaction conversations - invisible to all search. Daily/weekly/quarterly markdown files are redundant with the DB (not a problem). Fix: optional L5 layer that searches working/ files.

## Gap 5: No search on core facts or scratchpad

These are loaded into context directly but cannot be inspected via search. Fix: optional read-only dashboard endpoint, not a search layer.

## Gap 6: Emotion scoring inconsistency

agentbridge-recall does not apply emotion boost. memory-search-tool.ts does. memory-search-controller.ts does not. Same query, different ranking. Fix: falls out of Gap 2 consolidation.

## Priority

1. Gap 1 - one-line fix, unlocks daily search
2. Gap 3 - quick fix, non-ASCII auto-detect
3. Gap 2 - medium effort, consolidate search
4. Gap 6 - free with Gap 2
5. Gap 4 - nice-to-have
6. Gap 5 - nice-to-have
