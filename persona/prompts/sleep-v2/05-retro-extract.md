# Retrospective Extraction

Extract lessons and mistakes from today's retrospective as memories.

## Pre-loaded data

Retrospective content:
${RETRO_CONTENT}

## Task

1. Identify lessons, mistakes, and insights from the retrospective.
2. For each candidate, run `agentbridge-recall` with the key phrase to check for duplicates.
3. If no duplicate exists, store via `agentbridge-store`.
4. If a mistake repeats a previously stored mistake, store it with escalated emotion score (`-2` from previous).
5. Respond with the count of memories stored.
