# Core Promotion

Promote worthy general-tier memories to core tier.

## Pre-loaded data

Promotion candidates (high relevance, frequently recalled):
${PROMOTION_CANDIDATES}

## Constraints

- Budget: 100 core entries max. Do not exceed.
- Only promote memories that represent enduring facts, strong preferences, or critical context.
- Do not promote transient or time-bound information.

## Task

For each worthy candidate:
```
agentbridge-edit --memory-id N --tier core
```

Respond with the list of promotions made.
