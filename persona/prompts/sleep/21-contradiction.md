# §8j Contradiction Check

Before promoting any memory to core tier (step 17), check for contradictions.

For each candidate memory being promoted:
1. Recall existing core memories in the same topic
2. Check if the new fact contradicts an existing core fact
3. If contradiction found:
   - Invalidate the OLD core memory: `agentbridge-edit --memory-id <OLD_ID> --valid-to "${WAKEUP_DATE}" --caller dreamy`
   - Promote the NEW memory to core: `agentbridge-edit --memory-id <NEW_ID> --tier core --caller dreamy`
   - Log: "Contradiction resolved: invalidated #OLD, promoted #NEW"

**Contradiction signals:**
- Same topic + overlapping entities + negation ("not", "no longer", "switched from", "replaced", "instead of")
- Same topic + same entity + different value ("uses Auth0" vs "uses Clerk")

**Rules:**
- Only flag clear contradictions — don't flag updates that add detail
- "We use Clerk" + "Clerk pricing is $50/mo" = NOT a contradiction (additive)
- "We use Auth0" + "We switched to Clerk" = contradiction (replacement)
- When in doubt, keep both — false negatives are better than false positives
