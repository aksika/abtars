---
alwaysApply: true
---

# Feature Update Workflow

When modifying an existing feature (bug fix, behavior change, refactoring), follow this sequence strictly.

## 1. Codebase Analysis First

Before writing any code, map the full surface area of the feature:

```
search for: class names, function names, constants, config keys, file patterns
check for: duplicate implementations, shared state, multiple call sites
```

- **Find ALL instances** — the same logic often exists in 2-3 places (e.g., startup path AND heartbeat path AND CLI path). Fixing one and missing another creates subtle bugs.
- **Trace the data flow** — who creates the object, who calls it, who reads its state. Draw the chain mentally before touching anything.
- **Check for shared vs separate instances** — if two code paths create their own instance of the same class, in-memory state (flags, caches) won't be shared. This is a common source of "fix doesn't work" bugs.

## 2. Fix the Root Cause, Not the Symptom

Ask: "Why does this happen?" not "How do I stop this from happening?"

Bad: add a sleep() delay to avoid a race condition.
Good: add a concurrency guard that prevents the race entirely.

Bad: check for duplicates after they're created.
Good: prevent duplicates from being created.

## 3. Refactor Duplicates Before Fixing

If the analysis reveals the same logic in multiple places:
1. **Refactor first** — unify into a single source of truth
2. **Then fix** — apply the fix once in the unified code
3. **Then test** — tests cover the single implementation

Do NOT fix the same bug in 2-3 places independently. That's a maintenance trap.

## 4. Update Tests — Never Skip

Every behavior change requires test updates:
- **Stale tests are lies** — a test asserting "always returns true" when the code now checks conditions will pass by accident or mislead future developers.
- **Test the guard/condition, not just the happy path** — if you add a `spawnedToday` flag, test that it blocks the second call.
- **Test cross-path interactions** — if startup and cron share state, test that startup firing blocks cron.

## 5. Verify the Deployed Code

A fix in source means nothing if the running process uses old compiled output:
- After fixing: `npm run build` → verify the compiled output contains the fix
- Check what the running process actually executes (which binary, which dist path)
- Spawned subprocesses may use different paths than the parent (wrapper scripts, symlinks, deploy scripts)

## 6. Check for Orphans

Any code that spawns detached/background processes must:
- Track what it spawned (pid, timestamp)
- Have a cleanup path (timeout kill, exit handler)
- Be verified after deploy: `ps aux | grep` for zombies from pre-fix runs

## 7. Silent Failures Kill

If a process runs with `stdio: "ignore"`, crashes are invisible. When debugging:
- Temporarily switch to `stdio: "inherit"` or pipe to a log file
- Run the same command manually to see errors
- Add error reporting that survives stdio suppression (write to a status file)

## Checklist

Before marking a feature update as done:

- [ ] Searched for ALL instances of the affected logic across the codebase
- [ ] No duplicate implementations remain (refactored if needed)
- [ ] Shared state uses a single instance, not separate copies
- [ ] Tests updated to match new behavior (no stale assertions)
- [ ] New guard/condition paths have dedicated tests
- [ ] Built and verified the compiled output contains the fix
- [ ] Checked for orphaned processes from pre-fix runs
- [ ] Full test suite passes
