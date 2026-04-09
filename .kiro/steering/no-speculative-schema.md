---
alwaysApply: true
---

# No Speculative Schema

Don't add a database column, FTS index, or exported function until:
1. Code exists that **writes** it
2. Code exists that **reads** it
3. A test proves the **round-trip**

If a feature is planned but not implemented, document it in the spec — not in the schema.
