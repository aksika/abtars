#!/usr/bin/env node
/**
 * #1711 Phase 2 anti-regrowth guard for scripts/abtars-watchdog.sh.
 *
 * The watchdog shell must never grow new reconciliation logic: no process
 * selection, no pgrep/pkill, no JSON/Python parsing beyond the legacy
 * exit-code reads, and exactly one canonical absolute spawn literal.
 * Baselines pin EXISTING technical debt (named as such until Phase 3); any
 * increase fails.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wdPath = join(scriptDir, "abtars-watchdog.sh");
const src = readFileSync(wdPath, "utf-8");

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

const failures = [];

// Existing debt — may not GROW (full reducer migration is a separately
// approved Phase 3). Needles match actual invocations, not prose.
const baselines = {
  "$(python3 -c \"": { max: 3, why: "legacy lastExitCode reads" },
  "json.load": { max: 3, why: "legacy JSON parsing in exit-code reads" },
};

// Forbidden outright — reconciliation must stay behind the typed boundary.
const forbidden = ["pgrep", "pkill", "reconcile-enumerate"];

for (const [needle, { max, why }] of Object.entries(baselines)) {
  const n = countOccurrences(src, needle);
  if (n > max) {
    failures.push(`pattern "${needle}" occurs ${n}x (baseline ${max} — ${why}); migrate via Phase 3 instead of growing the shell`);
  }
}

for (const needle of forbidden) {
  const n = countOccurrences(src, needle);
  if (n > 0) {
    failures.push(`forbidden pattern "${needle}" occurs ${n}x — reconciliation belongs behind the typed boundary`);
  }
}

// Canonical identity contract (R2): one normalized home, one absolute literal.
if (!/^while \[\[ "\$AB" == \*\/ && "\$AB" != "\/" \]\]; do AB="\$\{AB%\/\}"; done$/m.test(src)) {
  failures.push("missing ABTARS_HOME trailing-separator normalization for $AB");
}
const spawnSpellings = src.match(/[^\s"']*app\/bundle\/abtars\.js/g) ?? [];
if (spawnSpellings.length !== 1 || spawnSpellings[0] !== "$AB/app/bundle/abtars.js") {
  failures.push(`expected exactly one canonical spawn spelling "$AB/app/bundle/abtars.js", found ${JSON.stringify(spawnSpellings)}`);
}
// One-line exec/nohup form keeps $! the real node PID (#1261).
if (!/exec env [^\n]*nohup node [^\n]*200>&- &/.test(src)) {
  failures.push("spawn line lost its one-line exec/nohup form ($! must be the node PID)");
}

if (failures.length > 0) {
  console.error("watchdog shape guard FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("watchdog shape guard OK");
