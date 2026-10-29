#!/usr/bin/env node
// check-orc-authority.mjs — #1792 Task 5: supervised-transition authority guard.
//
// Enforces the FINAL caller→operation map (specs/1792/task1-checkpoint.md §4):
// only the runner core, its invoked arms (ports), and named narrow delegates
// may touch supervised phase-mutation APIs. Line-walk based, like
// check-imports.mjs: an architectural regression check, not a security
// sandbox. Runtime authority/version predicates remain necessary (they live
// in the store).
//
// Wired into `npm run check-imports`. Run directly for the cutover checklist:
// `node scripts/check-orc-authority.mjs` (exit nonzero on hits).
// `node scripts/check-orc-authority.mjs --self-test` runs the embedded
// negative/positive fixtures (extra setters, alias imports, direct phase SQL,
// release false-positives).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const SRC = join(ROOT_DIR, "src");

// Files that may call phase-mutation APIs (the runner, its store, schema).
const RUNNER_FILES = new Set([
  "src/components/orc-project/orc-workflow-runner.ts",
  "src/components/orc-project/orc-workflow-store.ts",
  "src/components/orc-project/workflow-schema.ts",
]);

// Runner-invoked arms: executor/reviewer/planner backends the runner drains
// through. They call mutators only inside runner-owned transitions
// (admission anchor, first-dispatch executing, terminal projections).
const RUNNER_ARMS = new Set([
  "src/components/orc-project/orc-workflow-ports.ts",
]);

// SHA pair: incident lifecycle owns SHA tables (admit/bind/transition) and
// the provision/block supervision writes for non-runner SHA roots
// (provision initializes executing for the dispatch fence; block terminalizes
// on incident block; a live runner run is additionally cancelled through the
// runner — see blockIncident). No planning/review orchestration may live here.
const SHA_FILES = new Set([
  "src/components/sha/sha-incident-coordinator.ts",
  "src/components/sha/sha-incident-store.ts",
]);
const SHA_OWNED_MUTATORS = new Set([
  "admitEventInTx", "admitEventWithCooldownInTx", "bindProvisioned",
  "initializeSupervision", "blockProject",
]);

// Narrow delegates: files allowed to IMPORT the stores (readers, brief
// assembly, dispatch arms, settlement mechanics invoked by the runner,
// schema init, CLI maintenance). They may NOT call the mutator methods
// below — the call check applies to every file outside RUNNER_FILES,
// RUNNER_ARMS and SHA_FILES, delegates included.
const DELEGATE_IMPORTS = new Set([
  "src/components/project-acceptance/project-review-service.ts",
  "src/components/tasks/kanban-delivery.ts",
  "src/components/tasks/task-run-settler.ts",
  "src/components/tasks/scheduled-run-coordinator.ts",
  "src/components/tasks/due-sources.ts",
  "src/components/orc-project/orc-workflow-runner.ts",
  "src/components/orc-project/orc-workflow-store.ts",
  "src/components/orc-project/workflow-schema.ts",
  "src/components/sha/sha-incident-store.ts",
  "src/components/tasks/kanban-board.ts",
  "src/components/reconciler.ts",
  "src/components/execution-control.ts",
  "src/components/spin-worker-adapter.ts",
  "src/components/worker-supervision-service.ts",
  "src/components/transport/tool-registry.ts",
  "src/components/project-acceptance/project-criterion-coverage.ts",
  "src/components/project-acceptance/project-review-case.ts",
  "src/components/project-acceptance/project-review-validator.ts",
  "src/components/orc-project/orc-workflow-ensure.ts",
  "src/components/orc-project/orc-project-context.ts",
  "src/components/orc-project/orc-project-coordinator.ts",
  "src/components/sha/sha-incident-coordinator.ts",
  "src/cli/commands/doctor-fixes.ts",
]);

// Worker release ingress boundary: the run-store release/claim CAS chain is
// live for worker-turn settlement ingress. Only these files may call the
// listed mutators (narrower than a blanket allowlist).
const RELEASE_PATHS = new Map([
  ["src/components/orc-project/orc-project-coordinator.ts", new Set(["release", "supersede"])],
  ["src/components/spin.ts", new Set(["bindExecution", "release", "releaseOwnedRun"])],
]);

// Phase-mutation methods callable only inside RUNNER_FILES / RUNNER_ARMS
// (plus SHA-owned ones inside SHA_FILES, release ones inside RELEASE_PATHS).
const MUTATORS = [
  "stateTransition", "blockProject", "initializeSupervision", "ensureAwaitingContract",
  "bindWorkspace", "claimCoverageRound", "recordCoverageClear", "recordCoverageReviewable",
  "insertReviewCase", "insertReviewRequest", "settleAcceptance", "settleBlocked",
  "settleRepair", "settleNeedsInput", "recordInvalidProposal", "recordInvalidContractProposal",
  "claimIntent", "promoteRun", "bindExecution", "releaseOwnedRun",
  "kanbanCompleteProject", "kanbanFailProject", "kanbanAttachProjectResult",
  "kanbanSetProjectDeliveryReady", "kanbanClaimProjectDelivery",
  "admitEventInTx", "admitEventWithCooldownInTx", "bindProvisioned",
  "supersede", "release",
];

// Deleted authorities: removed, not allowlisted — any occurrence anywhere
// (definition, call, or import, including tests and RUNNER_FILES) is a
// violation. The seven schedule* methods died with the supervised scheduling
// brain; the trio died with salvage/unconditional writes.
const DELETED_ANYWHERE = [
  "setState", "claimSalvageExecution", "scheduleProjectSalvage",
  "scheduleContractAuthoring", "scheduleProjectExecution", "scheduleReview",
  "scheduleRepairReview", "scheduleInputResume", "scheduleOperatorTurn",
];

// Raw SQL sites restricted to the private persistence modules + schema init.
const SQL_SITES = [
  "UPDATE project_supervision SET", "INSERT INTO project_supervision",
  "INSERT INTO project_contracts", "INSERT INTO project_review_cases",
  "INSERT INTO project_review_decisions", "INSERT INTO project_review_requests",
  "UPDATE project_review_", "UPDATE orc_project_runs SET", "INSERT INTO orc_project_runs",
  "UPDATE sha_incidents SET", "INSERT INTO sha_incidents",
  "INSERT INTO workflow_runs", "INSERT INTO workflow_plan_revisions",
  "INSERT INTO workflow_nodes", "INSERT INTO workflow_node_deps",
  "INSERT INTO workflow_operations", "INSERT INTO workflow_budgets",
  "INSERT INTO workflow_commands", "INSERT INTO workflow_ingress",
  "INSERT INTO workflow_deliveries", "UPDATE workflow_",
];
const SQL_ALLOWLIST = new Set([
  "src/components/project-acceptance/project-review-store.ts",
  "src/components/orc-project/orc-project-run-store.ts",
  "src/components/sha/sha-incident-store.ts",
  "src/components/tasks/kanban-board.ts",
  "src/components/orc-project/orc-workflow-store.ts",
  "src/components/orc-project/workflow-schema.ts",
]);

// Module imports restricted to the runner/delegates.
const IMPORT_SITES = [
  "project-review-store", "orc-project-run-store",
];

// `.release(` false-positive receivers: quota/lock/hold/session releases are
// not run-store releases. Negative lookbehind keeps the matcher honest
// (covered by --self-test fixtures).
const RELEASE_RECEIVER_ALLOW = ["executions", "quota", "lock", "hold", "reservation"];
const releaseRe = new RegExp(
  `(?<!${RELEASE_RECEIVER_ALLOW.join("|")})\\.release\\s*\\(`,
);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      yield full;
    }
  }
}

const violations = [];
function hit(rel, line, text) {
  violations.push(`${rel}:${line}: ${text.trim().slice(0, 160)}`);
}

function checkLine(rel, line, i) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
  const inRunner = RUNNER_FILES.has(rel) || RUNNER_ARMS.has(rel);
  const inSha = SHA_FILES.has(rel);
  const inTests = rel.startsWith("src/tests/");
  // 0. Deleted authorities anywhere (definition, call, or import alias).
  for (const m of DELETED_ANYWHERE) {
    const re = new RegExp(`\\.${m}\\s*\\(|\\b${m}\\s*\\(|\\b${m}\\s*:\\s*function\\b|\\bimport\\b[^;]*\\b${m}\\b`);
    if (re.test(line)) {
      hit(rel, i + 1, `deleted authority .${m}() must not exist anywhere`);
      return;
    }
  }
  // 1. Mutator calls outside the runner boundary (tests exempt: harness
  // scaffolding establishes fence prerequisites for retained executor
  // machinery; ported fixtures use production admission — see ledger).
  if (!inRunner && !inTests) {
    for (const m of MUTATORS) {
      const pattern = m === "release" ? releaseRe : new RegExp(`\\.${m}\\s*\\(|\\b${m}\\s*:\\s*function\\b`);
      if (pattern.test(line) && !trimmed.startsWith("import ")) {
        if (inSha && SHA_OWNED_MUTATORS.has(m)) break;
        const allowed = RELEASE_PATHS.get(rel);
        if (allowed && allowed.has(m)) break;
        hit(rel, i + 1, `forbidden phase-mutator use .${m}() outside the runner`);
        break;
      }
    }
  }
  // 2. Raw SQL sites outside the private persistence modules.
  if (!SQL_ALLOWLIST.has(rel)) {
    for (const site of SQL_SITES) {
      if (line.includes(site)) {
        hit(rel, i + 1, `restricted SQL site outside private persistence: ${site}`);
        break;
      }
    }
  }
  // 3. Store imports outside runner/delegates (runtime imports only).
  // Test scaffolding imports are exempt (rules 0/2/4 still apply to tests).
  if (!inTests && !trimmed.startsWith("import type ") && trimmed.startsWith("import ")) {
    for (const site of IMPORT_SITES) {
      if (line.includes(site) && ![...DELEGATE_IMPORTS].some((d) => rel === d)
        && !RUNNER_FILES.has(rel) && !RUNNER_ARMS.has(rel)) {
        hit(rel, i + 1, `restricted store import outside runner/delegates: ${site}`);
        break;
      }
    }
  }
  // 4. Direct reconciler wake/phase calls outside the runner + boot wiring.
  if (/requestReconcileForProject/.test(line) && !trimmed.startsWith("import ")) {
    const allowed = rel === "src/components/orc-project/orc-workflow-runner.ts"
      || rel === "src/components/orc-project/orc-workflow-store.ts"
      || rel === "src/components/reconciler.ts"
      || rel.startsWith("src/boot/");
    if (!allowed) {
      hit(rel, i + 1, "reconciler phase call outside the runner boundary");
    }
  }
}

// Embedded fixtures: --self-test asserts the matchers hit the bad lines and
// stay silent on the good ones (extra setters, alias imports, direct phase
// SQL, release false-positives).
const SELF_TEST_FIXTURES = [
  { rel: "src/components/reconciler.ts", line: `  review.setState(12, "executing");`, hit: true },
  { rel: "src/components/spin.ts", line: `  coordinator.scheduleReview(1, 1, "rc");`, hit: true },
  { rel: "src/components/spin.ts", line: `  import { scheduleReview as sr } from "./orc-project-coordinator.js";`, hit: true },
  { rel: "src/components/orc-project/orc-project-coordinator.ts", line: `  coordinator.scheduleContractAuthoring(1);`, hit: true },
  { rel: "src/components/tasks/task-checker.ts", line: `  store.stateTransition(1, ["a"], "executing");`, hit: true },
  { rel: "src/components/orc-project/orc-workflow-runner.ts", line: `  store.stateTransition(1, ["a"], "executing");`, hit: false },
  { rel: "src/components/orc-project/orc-workflow-ports.ts", line: `  this.reviewStore.ensureAwaitingContract(1);`, hit: false },
  { rel: "src/components/sha/sha-incident-coordinator.ts", line: `  this.store.admitEventInTx({});`, hit: false },
  { rel: "src/components/tasks/task-checker.ts", line: `  this.store.admitEventInTx({});`, hit: true },
  { rel: "src/components/tasks/due-sources.ts", line: `  UPDATE project_supervision SET state = 'x';`, hit: true },
  { rel: "src/components/project-acceptance/project-review-store.ts", line: `  UPDATE project_supervision SET state = 'x';`, hit: false },
  { rel: "src/components/spin.ts", line: `  const released = store.release(ctx, "completed");`, hit: false },
  { rel: "src/components/spin.ts", line: `  this.executions.release("agent", 1);`, hit: false },
  { rel: "src/components/transport/tool-registry.ts", line: `  deps.quota.release(rid);`, hit: false },
  { rel: "src/components/tasks/task-checker.ts", line: `  store.release(ctx, "failed");`, hit: true },
  { rel: "src/components/orc-project/orc-project-coordinator.ts", line: `  return this.store.release(ctx, "failed");`, hit: false },
  { rel: "src/components/reconciler.ts", line: `export function requestReconcileForProject(cardId: number): void {`, hit: false },
  { rel: "src/components/tasks/task-checker.ts", line: `  requestReconcileForProject(12);`, hit: true },
  { rel: "src/tests/e2e/local-swarm-runner.ts", line: `  store.stateTransition(1, ["a"], "executing");`, hit: false },
  { rel: "src/components/spin.ts", line: `import { ProjectReviewStore } from "./project-acceptance/project-review-store.js";`, hit: true },
  { rel: "src/components/reconciler.ts", line: `import { ProjectReviewStore } from "./project-acceptance/project-review-store.js";`, hit: false },
];

function runSelfTest() {
  let failures = 0;
  for (const [idx, fx] of SELF_TEST_FIXTURES.entries()) {
    const before = violations.length;
    checkLine(fx.rel, fx.line, 0);
    const got = violations.length > before;
    if (got) violations.length = before;
    if (got !== fx.hit) {
      failures++;
      console.log(`SELF-TEST #${idx} ${got ? "HIT" : "CLEAN"} but expected ${fx.hit ? "HIT" : "CLEAN"}: ${fx.rel}: ${fx.line}`);
    }
  }
  if (failures > 0) {
    console.log(`check-orc-authority --self-test: ${failures} fixture failure(s)`);
    process.exit(1);
  }
  console.log(`check-orc-authority --self-test: ${SELF_TEST_FIXTURES.length} fixtures pass`);
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  for (const full of walk(SRC)) {
    const rel = relative(ROOT_DIR, full);
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, i) => checkLine(rel, line, i));
  }

  if (violations.length > 0) {
    console.log(`check-orc-authority: ${violations.length} violation(s) of the #1792 final authority map:`);
    for (const v of violations) console.log(`VIOLATION ${v}`);
    process.exit(1);
  } else {
    console.log("check-orc-authority: clean — one transition authority.");
  }
}
