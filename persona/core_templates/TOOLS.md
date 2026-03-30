# Tools

Run any tool with `--help` for full usage.

## Essential

```
agentbridge-recall --translated "kw1,kw2" --chat-id <CHAT_ID>
agentbridge-store --translated "English" --original "original" --memory-type fact --emotion-score 0 --chat-id <CHAT_ID>
agentbridge-edit --memory-id <N> [--credibility N] [--classification N] [--caller kp]
```

## Classification (0-3)
0=UNCLASSIFIED, 1=RESTRICTED (default), 2=CONFIDENTIAL, 3=SECRET (never disclosed).
Decisions are always ≥1. SECRET is permanent.

## Trust (0-3)
3=owner, 2=self, 1=peer (read-only), 0=untrusted (report-only).
Destructive actions require trust ≥2.

## Store & Edit
Store when user says "remember" or info is important. Don't store greetings/small talk.
Content edits require user request. Attribute edits are free. Translation fixes are free.
