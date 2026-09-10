#!/usr/bin/env node
// check-orc-authority.mjs — #1792 Task 5: supervised-transition authority guard.
//
// Enforces the FINAL caller→operation map (specs/1792/task1-checkpoint.md §4):
// only orc-workflow-runner.ts and its private persistence module
// (orc-workflow-store.ts, workflow-schema.ts) plus named narrow delegates may
// touch supervised phase-mutation APIs. Line-walk based, like check-imports.mjs:
// an architectural regression check, not a security sandbox. Runtime
// authority/version predicates remain necessary (they live in the store).
//
// NOT wired into `npm run check-imports` until the Task-5 cutover commit:
// the pre-cutover tree legitimately violates the final boundary (the
// reconciler is still the supervised driver). Run directly for the cutover
// checklist: `node scripts/check-orc-authority.mjs` (exit nonzero on hits).

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

// Narrow delegates: files allowed to IMPORT the stores (readers, brief
// assembly, dispatch arms, settlement mechanics invoked by the runner).
// They may NOT call the mutator methods below — the call check applies to
// every file outside RUNNER_FILES, delegates included.
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
]);

// Phase-mutation methods. setState / claimSalvageExecution / scheduleProjectSalvage
// are ABSENT on purpose: they are deleted, not allowlisted — any occurrence
// anywhere (including RUNNER_FILES) is a violation.
const MUTATORS = [
  "stateTransition", "blockProject", "initializeSupervision", "ensureAwaitingContract",
  "bindWorkspace", "claimCoverageRound", "recordCoverageClear", "recordCoverageReviewable",
  "insertReviewCase", "insertReviewRequest", "settleAcceptance", "settleBlocked",
  "settleRepair", "settleNeedsInput", "recordInvalidProposal", "recordInvalidContractProposal",
  "claimIntent", "promoteRun", "bindExecution", "releaseOwnedRun",
  "scheduleContractAuthoring", "scheduleProjectExecution", "scheduleReview",
  "scheduleRepairReview", "scheduleInputResume", "scheduleOperatorTurn",
  "kanbanCompleteProject", "kanbanFailProject", "kanbanAttachProjectResult",
  "kanbanSetProjectDeliveryReady", "kanbanClaimProjectDelivery",
  "admitEventInTx", "admitEventWithCooldownInTx", "bindProvisioned",
  "setState", "claimSalvageExecution", "scheduleProjectSalvage", "supersede",
  "release",
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

for (const full of walk(SRC)) {
  const rel = relative(ROOT_DIR, full);
  const lines = readFileSync(full, "utf8").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    // 1. Mutator calls outside the runner boundary.
    if (!RUNNER_FILES.has(rel)) {
      for (const m of MUTATORS) {
        const re = new RegExp(`\\.${m}\\s*\\(|\\b${m}\\s*:\\s*function\\b`);
        if (re.test(line) && !trimmed.startsWith("import ")) {
          hit(rel, i + 1, `forbidden phase-mutator use .${m}() outside the runner`);
          break;
        }
      }
    } else {
      // Inside the boundary only the deleted trio is forbidden.
      for (const m of ["setState", "claimSalvageExecution", "scheduleProjectSalvage"]) {
        if (new RegExp(`\\.${m}\\s*\\(`).test(line)) {
          hit(rel, i + 1, `deleted authority .${m}() must not exist anywhere`);
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
    if (!trimmed.startsWith("import type ") && trimmed.startsWith("import ")) {
      for (const site of IMPORT_SITES) {
        if (line.includes(site) && ![...DELEGATE_IMPORTS].some((d) => rel === d)) {
          hit(rel, i + 1, `restricted store import outside runner/delegates: ${site}`);
          break;
        }
      }
    }
    // 4. Direct reconciler wake/phase calls outside the runner + boot wiring.
    // (#1792: abortProjectById deleted with the supervised brain; only the
    // wake facade remains, still restricted to the runner boundary.)
    if (/requestReconcileForProject/.test(line) && !trimmed.startsWith("import ")) {
      const allowed = rel === "src/components/orc-project/orc-workflow-runner.ts"
        || rel === "src/components/orc-project/orc-workflow-store.ts"
        || rel.startsWith("src/boot/");
      if (!allowed) {
        hit(rel, i + 1, "reconciler phase call outside the runner boundary");
      }
    }
  });
}

if (violations.length > 0) {
  console.log(`check-orc-authority: ${violations.length} violation(s) of the #1792 final authority map:`);
  for (const v of violations) console.log(`VIOLATION ${v}`);
  process.exit(1);
} else {
  console.log("check-orc-authority: clean — one transition authority.");
}
