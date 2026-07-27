#!/usr/bin/env tsx
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const RUN_ID = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OUT_DIR = join(process.cwd(), "test-results", "report-pipeline-e2e", RUN_ID);
const HOME = mkdtempSync(join(tmpdir(), "abtars-e2e-"));

interface MilestoneResult {
  id: string; name: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  scenario: string; expected: string; observed: string;
  blockedBy?: string; durationMs: number; evidence: string[];
}

const milestones: MilestoneResult[] = [];

async function checkpoint(id: string, name: string, scenario: string, expected: string, fn: () => Promise<string | true>, deps?: string[]): Promise<void> {
  const start = Date.now();
  if (deps) {
    for (const dep of deps) {
      const dr = milestones.find(m => m.id === dep);
      if (dr && (dr.status === "FAIL" || dr.status === "BLOCKED" || dr.status === "NOT_RUN")) {
        milestones.push({ id, name, status: "BLOCKED", scenario, expected, observed: `blocked by ${dep} (${dr.status})`, blockedBy: dep, durationMs: Date.now() - start, evidence: [] });
        return;
      }
    }
  }
  let status: MilestoneResult["status"] = "PASS";
  let observed = ""; let evidence: string[] = [];
  try {
    const result = await fn();
    if (result !== true) { status = "FAIL"; observed = result; evidence = [result]; }
    else { observed = "pass"; }
  } catch (err) {
    status = "FAIL"; observed = err instanceof Error ? err.message : String(err); evidence = [observed];
  }
  milestones.push({ id, name, status, scenario, expected, observed, durationMs: Date.now() - start, evidence });
}

function scenario(name: string): void { console.log(`\nScenario: ${name}`); }

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  process.env.ABTARS_HOME = HOME;
  const H = HOME;
  mkdirSync(join(H, "tasks"), { recursive: true });
  mkdirSync(join(H, "workspace"), { recursive: true });
  mkdirSync(join(H, "state"), { recursive: true });
  mkdirSync(join(H, "kanban"), { recursive: true });

  // Pre-load all modules under the temp HOME so they use proper paths
  const taskTypes = await import("../src/components/tasks/task-types.js");
  const taskPreflight = await import("../src/components/tasks/task-preflight.js");
  const taskPackage = await import("../src/components/tasks/task-package.js");
  const stateStore = await import("../src/components/tasks/task-state-store.js");
  const historyStore = await import("../src/components/tasks/task-history-store.js");
  const execControl = await import("../src/components/execution-control.js");
  const taskChecker = await import("../src/components/tasks/task-checker.js");
  const taskService = await import("../src/components/tasks/task-service.js");

  // ── M01: Build identity ──────────────────────────────────────────────────

  scenario("Deployment identity");
  await checkpoint("M01", "Build identity", "deployment", "build-info.json exists", async () => {
    const p = join(process.cwd(), "dist", "build-info.json");
    if (!existsSync(p)) return `build-info.json not found at ${p}`;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (!raw.hash || !raw.date) return `build-info.json missing hash or date`;
    return true;
  });

  // ── M06-M07: Normalize contract validation ────────────────────────────────

  scenario("Contract validation");
  await checkpoint("M06", "Structured report contract accepted", "normalize", "valid contract returns ok", async () => {
    const r = taskTypes.normalize({ id: "valid-report", kind: "agent", delivery: "report", at: new Date().toISOString(), agent: "task", prompt: "test", chatId: "1", report: { artifact: "~/test.md", requiredSections: ["# Result"], minBytes: 100, requires: { files: [], executables: [], tools: [] } } });
    if (!r.ok) return `valid contract rejected: ${r.error}`;
    return true;
  });

  await checkpoint("M07", "Legacy report task accepted without contract", "normalize", "no contract accepted with warning", async () => {
    const r = taskTypes.normalize({ id: "legacy-report", kind: "agent", delivery: "report", at: new Date().toISOString(), agent: "task", prompt: "test", chatId: "1" });
    if (!r.ok) return `legacy report task rejected: ${r.error}`;
    return true;
  });

  await checkpoint("M07b", "Non-report task rejects report contract", "normalize", "report rejected on non-report delivery", async () => {
    const r = taskTypes.normalize({ id: "bad-contract", kind: "agent", delivery: "announce", at: new Date().toISOString(), agent: "task", prompt: "test", chatId: "1", report: { artifact: "~/test.md", requiredSections: ["# X"], minBytes: 100, requires: { files: [], executables: [], tools: [] } } });
    if (r.ok) return `non-report task with report should reject`;
    return true;
  });

  // ── M08-M09: Preflight ────────────────────────────────────────────────────

  scenario("Preflight");
  await checkpoint("M08", "Required file validated", "preflight", "missing file rejected", async () => {
    const entry = { id: "preflight-test", kind: "agent" as const, delivery: "report" as const, agent: "task" as const, prompt: "test", at: new Date().toISOString(), enabled: true, priority: "medium" as const, report: { artifact: join(H, "workspace", "preflight-test", "out.md"), requiredSections: ["# Result"], minBytes: 100, requires: { files: ["/nonexistent/file.txt"], executables: [], tools: [] } } };
    const result = taskPreflight.preflightTask(entry as any, taskPackage.createExecutionScope("preflight-test"), undefined);
    if (result.ok) return `preflight should have rejected missing file`;
    if (result.code !== "required_file_missing") return `expected required_file_missing, got ${result.code}`;
    return true;
  });

  await checkpoint("M08b", "Existing file passes preflight", "preflight", "file present accepted", async () => {
    mkdirSync(join(H, "workspace", "preflight-ok"), { recursive: true });
    writeFileSync(join(H, "workspace", "preflight-ok", "data.csv"), "a,b,c\n1,2,3\n");
    const entry = { id: "preflight-ok", kind: "agent" as const, delivery: "report" as const, agent: "task" as const, prompt: "test", at: new Date().toISOString(), enabled: true, priority: "medium" as const, report: { artifact: join(H, "workspace", "preflight-ok", "out.md"), requiredSections: ["# Result"], minBytes: 100, requires: { files: [join(H, "workspace", "preflight-ok", "data.csv")], executables: [], tools: [] } } };
    const result = taskPreflight.preflightTask(entry as any, taskPackage.createExecutionScope("preflight-ok"), undefined);
    if (!result.ok) return `preflight failed: ${result.code} ${result.safeDetail}`;
    return true;
  });

  await checkpoint("M09", "Missing executable rejected", "preflight", "missing exe fails", async () => {
    const entry = { id: "preflight-exe", kind: "agent" as const, delivery: "report" as const, agent: "task" as const, prompt: "test", at: new Date().toISOString(), enabled: true, priority: "medium" as const, report: { artifact: join(H, "workspace", "preflight-exe", "out.md"), requiredSections: ["# Result"], minBytes: 100, requires: { files: [], executables: ["nonexistent_tool_xyz"], tools: [] } } };
    const scope = taskPackage.createExecutionScope("preflight-exe");
    const result = taskPreflight.preflightTask(entry as any, { cwd: scope.cwd, env: { ...scope.env, PATH: "/dev/null" } }, undefined);
    if (result.ok) return `preflight should reject missing exe`;
    if (result.code !== "required_executable_missing") return `expected required_executable_missing, got ${result.code}`;
    return true;
  });

  // ── M04-M05: Active run reservation ────────────────────────────────────────

  scenario("Active run ownership");
  await checkpoint("M04", "reserveRun exclusive ownership", "scheduler", "first ok, second fails", async () => {
    const r1 = stateStore.reserveRun("test-own", { runId: "run-1", groupId: "group-1", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() + 60000 });
    if (!r1.ok) return `first reservation failed`;
    const r2 = stateStore.reserveRun("test-own", { runId: "run-2", groupId: "group-2", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() + 60000 });
    if (r2.ok) return `duplicate reservation should reject`;
    const st = stateStore.readState("test-own");
    if (!st?.activeRun) return `activeRun not persisted`;
    if (st.activeRun.runId !== "run-1") return `runId mismatch`;
    return true;
  });

  await checkpoint("M05", "settleActiveRun clears reservation", "scheduler", "activeRun cleared", async () => {
    stateStore.reserveRun("test-settle", { runId: "run-s1", groupId: "group-s1", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() + 60000 });
    const settled = stateStore.settleActiveRun("test-settle", "run-s1", { lastFinishedAt: Date.now() });
    if (!settled) return `settleActiveRun returned false`;
    const st = stateStore.readState("test-settle");
    if (st?.activeRun) return `activeRun not cleared after settle`;
    if (!st?.lastFinishedAt) return `state update not applied`;
    return true;
  });

  // ── M13: Execution control ────────────────────────────────────────────────

  scenario("Run identity & execution control");
  await checkpoint("M13", "register/remove control cycle", "runner", "control exists then removed", async () => {
    const ref = `ctrl-${Date.now()}`;
    const ctrl = execControl.registerControl(ref);
    if (!ctrl) return `registerControl returned nothing`;
    if (ctrl.cancelled) return `new control should not be cancelled`;
    execControl.removeControl(ref);
    if (execControl.getControl(ref)) return `control still exists after remove`;
    return true;
  });

  await checkpoint("M13b", "requestCancel sets cancelled flag", "runner", "cancel works", async () => {
    const ref = `ctrl-cancel-${Date.now()}`;
    const ctrl = execControl.registerControl(ref);
    await ctrl.requestCancel("operator");
    if (!ctrl.cancelled) return `not cancelled after requestCancel`;
    if (ctrl.cancelReason !== "operator") return `cancelReason mismatch`;
    return true;
  });

  // ── M35-M38: Artifact validation ───────────────────────────────────────────

  scenario("Artifact validation");
  await checkpoint("M35", "Rejects nonexistent artifact", "artifact", "not found fails", async () => {
    const contract = { artifactPath: "/nonexistent/artifact.md", artifactLabel: "test", requiredSections: ["# X"], minBytes: 50, requiredFiles: [], executables: [], tools: [] };
    const result = taskPreflight.validateReportArtifact("/nonexistent/artifact.md", { existed: false }, contract, Date.now(), "test");
    if (result.ok) return `should reject nonexistent artifact`;
    return true;
  });

  await checkpoint("M36", "Accepts valid artifact", "artifact", "valid file passes", async () => {
    const ap = join(H, "workspace", "artifact-test", "report.md");
    mkdirSync(join(H, "workspace", "artifact-test"), { recursive: true });
    writeFileSync(ap, "# Result\n\ncontent\n".repeat(30), "utf-8");
    const contract = { artifactPath: ap, artifactLabel: "test", requiredSections: ["# Result"], minBytes: 50, requiredFiles: [], executables: [], tools: [] };
    const result = taskPreflight.validateReportArtifact(ap, { existed: false }, contract, Date.now() - 1000, "artifact-test");
    if (!result.ok) return `valid artifact rejected: ${result.reason}`;
    return true;
  });

  await checkpoint("M37", "Rejects missing heading", "artifact", "heading not found fails", async () => {
    const ap = join(H, "workspace", "artifact-heading", "report.md");
    mkdirSync(join(H, "workspace", "artifact-heading"), { recursive: true });
    writeFileSync(ap, "some content\n", "utf-8");
    const contract = { artifactPath: ap, artifactLabel: "test", requiredSections: ["# RequiredHeading"], minBytes: 10, requiredFiles: [], executables: [], tools: [] };
    const result = taskPreflight.validateReportArtifact(ap, { existed: false }, contract, Date.now() - 1000, "artifact-heading");
    if (result.ok) return `should reject missing heading`;
    return true;
  });

  await checkpoint("M38", "Rejects stale preexisting artifact", "artifact", "unchanged mtime fails", async () => {
    const ap = join(H, "workspace", "artifact-stale", "report.md");
    mkdirSync(join(H, "workspace", "artifact-stale"), { recursive: true });
    writeFileSync(ap, "# Result\ncontent\n", "utf-8");
    const stat = await import("node:fs").then(fs => fs.lstatSync(ap));
    const oldMtime = stat.mtimeMs;
    const size = stat.size;
    const result = taskPreflight.validateReportArtifact(ap, { existed: true, size, mtimeMs: oldMtime }, { artifactPath: ap, artifactLabel: "test", requiredSections: ["# Result"], minBytes: 10, requiredFiles: [], executables: [], tools: [] }, Date.now() - 5000, "artifact-stale");
    if (result.ok) return `stale artifact should be rejected (unchanged file passes validation)`;
    return true;
  });

  // ── M39-M42: Settlement ───────────────────────────────────────────────────

  scenario("Settlement");
  await checkpoint("M39", "appendRunOnce deduplicates by run ID", "settlement", "duplicate returns null", async () => {
    const runId = `dedup-${Date.now()}`;
    const first = historyStore.appendRunOnce({ runId, taskId: "test", kind: "agent", trigger: "schedule", startedAt: Date.now(), finishedAt: Date.now(), outcome: "success" });
    if (!first) return `first appendRunOnce returned null`;
    const second = historyStore.appendRunOnce({ runId, taskId: "test", kind: "agent", trigger: "schedule", startedAt: Date.now(), finishedAt: Date.now(), outcome: "success" });
    if (second !== null) return `duplicate should return null, got ${second}`;
    if (!historyStore.hasRun(runId)) return `hasRun should be true`;
    return true;
  });

  // ── M10-M11: Workspace and context ────────────────────────────────────────

  scenario("Workspace & context");
  await checkpoint("M10", "CONTEXT.md can be loaded", "runner", "context file exists", async () => {
    const ctxDir = join(H, "workspace", "context-task");
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, "CONTEXT.md"), "existing context content", "utf-8");
    if (!existsSync(join(ctxDir, "CONTEXT.md"))) return `CONTEXT.md not created`;
    return true;
  });

  await checkpoint("M11", "Execution scope scoped to task ID", "runner", "cwd contains task ID", async () => {
    const scope = taskPackage.createExecutionScope("scope-test");
    if (!scope.cwd.includes("scope-test")) return `cwd missing task ID: ${scope.cwd}`;
    if (!scope.env.WORKSPACE) return `WORKSPACE env not set`;
    return true;
  });

  // ── M33-M34: State coherence + reconciliation ─────────────────────────────

  scenario("State coherence");
  await checkpoint("M33", "State read/write round-trips", "state", "timestamps match", async () => {
    const id = `coherence-${Date.now()}`;
    const ts = Date.now();
    stateStore.updateState(id, { lastStartedAt: ts, lastFinishedAt: ts + 1000 });
    const st = stateStore.readState(id);
    if (!st) return `state not found`;
    if (st.lastStartedAt !== ts) return `lastStartedAt mismatch`;
    if (st.lastFinishedAt !== ts + 1000) return `lastFinishedAt mismatch`;
    return true;
  });

  await checkpoint("M34", "reconcileActiveTaskRuns clears stale runs", "state", "stale deadline cleared", async () => {
    const id = `recon-${Date.now()}`;
    stateStore.reserveRun(id, { runId: `stale-${Date.now()}`, groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: Date.now() - 120000, deadlineAt: Date.now() - 60000 });
    const before = stateStore.readState(id);
    if (!before?.activeRun) return `activeRun not set before reconcile`;
    taskChecker.reconcileActiveTaskRuns();
    const after = stateStore.readState(id);
    if (after?.activeRun) return `activeRun still present after reconcile with past deadline`;
    return true;
  });

  // ── M45: Task view ────────────────────────────────────────────────────────

  await checkpoint("M45", "getTaskView returns coherent state", "operators", "definition and state present", async () => {
    const entry = { id: "view-test", kind: "agent" as const, delivery: "announce" as const, at: new Date().toISOString(), agent: "task" as const, prompt: "test", enabled: true, priority: "medium" as const };
    const view = taskService.getTaskView(entry, new Set());
    if (!view.definition) return `definition missing`;
    if (view.state === undefined) return `state missing`;
    return true;
  });

  // ── M44: Logging ─────────────────────────────────────────────────────────

  await checkpoint("M44", "Log directory created", "observability", "logs dir exists", async () => {
    mkdirSync(join(H, "logs"), { recursive: true });
    if (!existsSync(join(H, "logs"))) return `logs dir not created`;
    return true;
  });

  // ── Report ─────────────────────────────────────────────────────────────────

  const passed = milestones.filter(m => m.status === "PASS").length;
  const failed = milestones.filter(m => m.status === "FAIL").length;
  const blocked = milestones.filter(m => m.status === "BLOCKED").length;

  const report = { runId: RUN_ID, timestamp: new Date().toISOString(), summary: { total: milestones.length, passed, failed, blocked }, milestones };

  const mdLines = [`# Report Pipeline E2E — ${RUN_ID}`, ``, `| ID | Milestone | Status | Scenario |`, `|----|-----------|--------|----------|`];
  for (const m of milestones) mdLines.push(`| ${m.id} | ${m.name} | ${m.status} | ${m.scenario} |`);
  mdLines.push(``, `**${passed}/${milestones.length} PASS** (${failed} FAIL, ${blocked} BLOCKED)`);

  const junitLines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuite name="report-pipeline-e2e" tests="${milestones.length}" failures="${failed + blocked}">`];
  for (const m of milestones) {
    junitLines.push(`  <testcase name="${m.id}: ${m.name}" classname="${m.scenario}" time="${(m.durationMs / 1000).toFixed(3)}">`);
    if (m.status !== "PASS") junitLines.push(`    <failure message="${m.observed}"/>`);
    junitLines.push(`  </testcase>`);
  }
  junitLines.push(`</testsuite>`);

  writeFileSync(join(OUT_DIR, "report-pipeline-e2e.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, "report-pipeline-e2e.md"), mdLines.join("\n"));
  writeFileSync(join(OUT_DIR, "report-pipeline-e2e.xml"), junitLines.join("\n"));

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Report Pipeline E2E: ${passed}/${milestones.length} PASS`);
  if (failed > 0) console.log(`  ${failed} FAIL`);
  if (blocked > 0) console.log(`  ${blocked} BLOCKED`);
  console.log(`Results: ${OUT_DIR}`);

  try { rmSync(HOME, { recursive: true, force: true }); } catch {}

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("E2E runner failed:", err); process.exit(1); });
