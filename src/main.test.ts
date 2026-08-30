/*
 * TEST DEFICIENCY (2026-08-30):
 * Missing: host smoke of the unhandledRejection/uncaughtException handlers
 * writing the FATAL reason into ~/.abtars/logs/bridge-<date>.log.
 * Reason deferred: a scratch bridge cannot be forced to raise a genuine
 * unhandled rejection from outside — there is no env-gated crash hook, and
 * injecting one is a multi-process harness with no added signal over the
 * identical guarded pattern shared by all three handlers.
 * Future verification: build, start a scratch bridge (ABTARS_HOME=/tmp/<n>),
 * send it a signal or force one rejection from a transport stub, then grep
 * the FATAL line in bridge-<date>.log.
 *
 * Evidence collected 2026-08-30 (exit handler, the most order-sensitive of
 * the three — it runs during process teardown): a scratch bridge exited
 * code=1 and the line
 *   ERROR [main] FATAL exit code=1 — <stack>
 * appeared in /tmp/abtars-smoke-1750/logs/bridge-2026-08-30.log before the
 * process terminated, proving the synchronous logError + flushLogs pair
 * survives the exit path. The unhandledRejection and uncaughtException
 * handlers (#1750) use the same guarded pair.
 */