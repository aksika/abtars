/**
 * scheduled-synthesis.integration.test.ts — #1792 writer-node + partial-evidence
 * journeys (replaces the retired salvage-admission suite).
 *
 * Disposition (design.md "Test disposition"): salvage admission assertions are
 * replaced with explicit writer-node and partial-evidence policy journeys.
 * Synthesis is now an explicit writer node kind ("work"|"synthesis"|"planning"|
 * "review"|"delivery") in runner plans — there is no separate salvage lifecycle
 * authority, so `claimSalvageExecution` pins nothing production does anymore
 * and is not exercised here. The deleted salvage-assertion themes map as:
 * - "lanes done → synthesis turn writes the report → review, never a second
 *   turn" → writer node writes the artifact, review judges the recorded
 *   outcome, and second-turn attempts are rejected loudly.
 * - "a live synthesis turn owns the project" → idempotent admission (duplicate
 *   wakes return the same run) and exactly-once attempt application.
 * - "#1791 report handoff" → the reviewer brief carries the writer outcome as
 *   citable evidence; the deleted `get_project_review_case` Orc tool path
 *   (getOrcTools() is now empty) is replaced by `assembleBrief` + verdict.
 * - "KP-35 repair shape" → partial-evidence policy: optional failures resolve
 *   explicitly, required failures settle, allowPartial succeeds on produced
 *   outputs, and writer validation rejects empty acceptance.
 *
 * Composition mirrors orc-workflow.e2e (green): real WorkflowRunner/
 * WorkflowStore/task DB over a mocked home with a seeded scheduled occurrence;
 * only the model planning/review turns, worker execution, destination
 * transport, and the clock are scripted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, rmSync as rmFile } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { vi } from "vitest";

let TEST_HOME: string;
let ARTIFACTS: string;
let RunnerType: typeof import("../../components/orc-project/orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("../../components/orc-project/orc-workflow-store.js").WorkflowStore;

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `synth-journey-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  ARTIFACTS = join(TEST_HOME, "artifacts");
  mkdirSync(ARTIFACTS, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const runnerMod = await import("../../components/orc-project/orc-workflow-runner.js");
  const storeMod = await import("../../components/orc-project/orc-workflow-store.js");
  RunnerType = runnerMod.WorkflowRunner;
  StoreType = storeMod.WorkflowStore;
});

afterAll(() => {
  if (existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

type Runner = import("../../components/orc-project/orc-workflow-runner.js").WorkflowRunner;
type Store = import("../../components/orc-project/orc-workflow-store.js").WorkflowStore;
type Proposal = import("../../components/orc-project/orc-workflow-runner.js").PlanProposal;

let cardSeq = 30000;
let runSeq = 0;

function makeRunner(): { runner: Runner; store: Store } {
  const store = new StoreType();
  const runner = new RunnerType(store, ["general", "research", "write"]);
  return { runner, store };
}

/** Scheduled root card carrying the occurrence correlation (e2e pattern). */
function seedCard(store: Store, runId: string): number {
  const id = cardSeq++;
  store.db.prepare(`INSERT INTO kanban_board (id, title, source, source_id, type, status, goal) VALUES (?, ?, ?, ?, 'O', 'running', ?)`)
    .run(id, `synth-journey-${id}`, "task", runId, `deliver report ${id}`);
  return id;
}

/** Reserved occurrence at the scheduling boundary (production input shape). */
function seedOccurrence(store: Store, taskId: string, runId: string): void {
  store.db.prepare(`INSERT OR IGNORE INTO task_state (task_id) VALUES (?)`).run(taskId);
  store.db.prepare(
    `INSERT INTO task_runs (run_id, task_id, group_id, attempt, trigger, occurrence_at,
      reserved_at, deadline_at, phase, last_progress_at, owner_pid)
     VALUES (?, ?, ?, 1, 'schedule', 1000, 1000, 9999999999, 'executing', 1000, 123456)`,
  ).run(runId, taskId, taskId);
}

function admitScheduled(runner: Runner, store: Store, taskId: string) {
  runSeq++;
  const runId = `synth-run-${runSeq}`;
  const card = seedCard(store, runId);
  seedOccurrence(store, taskId, runId);
  const admitted = runner.admitSupervised({ rootCardId: card, source: "task", sourceId: runId, scheduledRunId: runId });
  expect(admitted.kind).not.toBe("conflict");
  return { runId: admitted.runId as string, card, rootKind: admitted.rootKind };
}

function writeArtifact(name: string, content: string): string {
  const path = join(ARTIFACTS, name);
  writeFileSync(path, content);
  return path;
}

function digestOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf-8").digest("hex")}`;
}

function scriptedPorts(dispatched?: string[]) {
  return {
    executor: {
      name: "synth-exec",
      dispatch: (cmd: { nodeId: string }) => { dispatched?.push(cmd.nodeId); },
    },
    reviewer: {
      name: "synth-reviewer",
      startReview: (_cmd: unknown, _brief: unknown) => {},
    },
    planner: {
      name: "synth-planner",
      startPlanning: (_cmd: unknown, _input: unknown) => {},
    },
  };
}

/** Two research lanes + an explicit writer node + a review node. */
const lanesPlusWriter = (): Proposal => ({
  requiredOutputs: ["report"],
  nodes: [
    { label: "lane-a", kind: "work", instructions: "research a", capability: "research", outputs: ["notes-a"], acceptance: ["thorough"], dependsOn: [] },
    { label: "lane-b", kind: "work", instructions: "research b", capability: "research", outputs: ["notes-b"], acceptance: ["thorough"], dependsOn: [] },
    { label: "writer", kind: "synthesis", instructions: "meld lanes into the dossier", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["lane-a", "lane-b"] },
    { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["writer"] },
  ],
});

describe("#1792 synthesis writer-node journeys (replaces salvage admission)", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    ({ runner, store } = makeRunner());
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
      store.db.exec(`DELETE FROM ${t}`);
    }
  });

  it("lanes done → explicit writer node produces the report → review accepts, never a second writer turn", () => {
    const { runId, card } = admitScheduled(runner, store, "daily-dossier");
    const acc = runner.acceptPlan(runId, lanesPlusWriter());
    const dispatched: string[] = [];
    const ports = scriptedPorts(dispatched);
    runner.drain(10, ports);
    expect(dispatched).toContain(acc.nodeIds[0]);
    expect(dispatched).toContain(acc.nodeIds[1]);
    expect(dispatched).not.toContain(acc.nodeIds[2]);

    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, "att-lane-a", "{}");
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, "att-lane-b", "{}");
    runner.drain(10, ports);
    // Both lanes terminal: the writer — and only the writer — is now queued.
    expect(dispatched).toContain(acc.nodeIds[2]);

    // The writer turn's durable effects: report written, outcome recorded.
    const body = "# Dossier\n\n## Findings\n\n- melded lane evidence\n";
    const reportPath = writeArtifact(`dossier-${runId}.md`, body);
    runner.attemptSucceeded(
      runId, acc.nodeIds[2] as string, "att-writer",
      JSON.stringify({ artifact: reportPath, digest: digestOf(body) }),
    );
    runner.drain(10, ports);

    // Review judges the RECORDED writer outcome, reading the actual artifact.
    const brief = runner.assembleBrief(runId, 1, acc.nodeIds[3] as string);
    const writerOutcome = JSON.parse(
      (brief.nodes.find((n) => n.nodeId === acc.nodeIds[2])?.outcome ?? "{}") as string,
    ) as { artifact?: string; digest?: string };
    expect(writerOutcome.artifact).toBe(reportPath);
    expect(writerOutcome.digest).toBe(digestOf(body));
    expect(readFileSync(writerOutcome.artifact as string, "utf8")).toContain("## Findings");

    expect(runner.submitVerdict(runId, acc.nodeIds[3] as string, { verdict: "accept" })).toBe("accepted");
    // Accepted content is not proof of delivery: the run waits for ack.
    expect(store.getRun(runId)?.state).not.toBe("succeeded");
    const sender = { name: "synth-sender", send: (doc: { idempotenceKey: string }) => `receipt:${doc.idempotenceKey}` };
    expect(runner.executeDelivery(runId, acc.nodeIds[3] as string, sender)).toBe("acknowledged");
    expect(store.getRun(runId)?.state).toBe("succeeded");

    const cardRow = store.db.prepare(`SELECT status, result_summary FROM kanban_board WHERE id = ?`).get(card) as { status: string; result_summary: string | null };
    expect(cardRow.status).toBe("done");
    expect(typeof cardRow.result_summary).toBe("string");
    expect(runner.auditTick(0).ownerless).not.toContain(runId);

    // Never a second writer turn: the initial plan is single-shot, and late
    // writer results on the terminal run are rejected loudly, not applied.
    expect(() => runner.acceptPlan(runId, lanesPlusWriter())).toThrow(/already terminal|use submitPlanProposal/);
    expect(() => runner.attemptSucceeded(runId, acc.nodeIds[2] as string, "att-writer-late", "{}"))
      .toThrow(/terminal.*late result rejected/);
  });

  it("a live writer run owns the project: duplicate admission returns the same run and dispatches nothing twice", () => {
    const { runId, card } = admitScheduled(runner, store, "daily-dossier-dup");

    // Duplicate wake while the run is live: idempotent admission, same run.
    const dup = runner.admitSupervised({ rootCardId: card, source: "task", sourceId: `synth-run-${runSeq}`, scheduledRunId: `synth-run-${runSeq}` });
    expect(dup.kind).toBe("duplicate");
    expect(dup.runId).toBe(runId);
    expect(store.db.prepare(`SELECT COUNT(*) AS c FROM workflow_runs WHERE root_card_id = ?`).get(card) as { c: number }).toEqual({ c: 1 });

    const acc = runner.acceptPlan(runId, lanesPlusWriter());
    const dispatched: string[] = [];
    const ports = scriptedPorts(dispatched);
    runner.drain(10, ports);
    const firstPass = dispatched.length;
    expect(firstPass).toBeGreaterThanOrEqual(2);
    // Second drain claims nothing new — no double dispatch of live work.
    expect(runner.drain(10, ports)).toBe(0);
    expect(dispatched).toHaveLength(firstPass);

    // Exactly-once attempt application: the same attempt id cannot complete twice.
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, "att-once", "{}");
    expect(() => runner.attemptSucceeded(runId, acc.nodeIds[0] as string, "att-once", "{}"))
      .toThrow(/conflicts with completion/);
  });

  it("#1791 report handoff: writer outcome is citable review evidence and survives later file mutation", () => {
    const { runId } = admitScheduled(runner, store, "daily-dossier-handoff");
    const acc = runner.acceptPlan(runId, lanesPlusWriter());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, "att-ha", "{}");
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, "att-hb", "{}");
    runner.drain(10, ports);

    // The writer's durable effects: report written with digest, turn recorded.
    const reportBody = "# Dossier\n\n## Findings\n\n- melded lane evidence\n";
    const reportPath = writeArtifact(`handoff-${runId}.md`, reportBody);
    const expectedDigest = digestOf(reportBody);
    runner.attemptSucceeded(
      runId, acc.nodeIds[2] as string, "att-hw",
      JSON.stringify({ artifact: reportPath, digest: expectedDigest }),
    );
    runner.drain(10, ports);

    // The reviewer brief carries the writer outcome as citable evidence.
    const brief = runner.assembleBrief(runId, 1, acc.nodeIds[3] as string);
    const writerNode = brief.nodes.find((n) => n.nodeId === acc.nodeIds[2]);
    expect(writerNode?.status).toBe("succeeded");
    const outcome = JSON.parse(writerNode?.outcome ?? "{}") as { artifact?: string; digest?: string };
    expect(outcome.artifact).toBe(reportPath);
    expect(outcome.digest).toBe(expectedDigest);
    expect(readFileSync(outcome.artifact as string, "utf8")).toBe(reportBody);

    expect(runner.submitVerdict(runId, acc.nodeIds[3] as string, { verdict: "accept" })).toBe("accepted");
    const sender = { name: "synth-sender", send: (_doc: { idempotenceKey: string }) => "receipt" };
    expect(runner.executeDelivery(runId, acc.nodeIds[3] as string, sender)).toBe("acknowledged");
    expect(store.getRun(runId)?.state).toBe("succeeded");

    // Immutability: replacing then deleting the file cannot change the judged
    // evidence — review judged the stored outcome, never the live filesystem.
    writeFileSync(reportPath, "# Replaced\n", "utf-8");
    rmFile(reportPath, { force: true });
    const stored = store.listNodes(runId, 1).find((n) => n["node_id"] === acc.nodeIds[2]);
    expect(stored?.["status"]).toBe("succeeded");
    const storedOutcome = JSON.parse(stored?.["outcome"] as string) as { artifact?: string; digest?: string };
    expect(storedOutcome.digest).toBe(expectedDigest);
    expect(storedOutcome.artifact).toBe(reportPath);
  });

  it("partial-evidence policy: optional failure proceeds, required failure settles, writer validation rejects empty acceptance", () => {
    // Writer validation: a synthesis node with no acceptance criterion is not
    // plannable — runner acceptance with empty outputs fails validation.
    const badWriter: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "writer", kind: "synthesis", instructions: "write", capability: "write", outputs: ["report"], acceptance: [], dependsOn: [] },
      ],
    };
    expect(runner.validatePlan(badWriter).some((d) => d.field.includes("acceptance"))).toBe(true);

    // Optional lane failure resolves explicitly: dependents proceed without
    // the optional input, and the failure stays visible in the run evidence.
    const withOptional: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "core", kind: "work", instructions: "core research", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
        { label: "extra", kind: "work", instructions: "optional scrape", capability: "research", outputs: ["scrape"], acceptance: ["fresh"], dependsOn: [], optional: true },
        { label: "writer", kind: "synthesis", instructions: "meld into report", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["core", "extra"] },
        { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["writer"] },
      ],
    };
    const opt = admitScheduled(runner, store, "partial-optional");
    const optAcc = runner.acceptPlan(opt.runId, withOptional);
    const optPorts = scriptedPorts();
    runner.drain(10, optPorts);
    runner.attemptFailed(opt.runId, optAcc.nodeIds[1] as string, "att-extra", "source down", false);
    // The run is NOT failed: the optional failure released its dependents.
    expect(["admitted", "planning", "dispatched", "executing"]).toContain(store.getRun(opt.runId)?.state);
    runner.attemptSucceeded(opt.runId, optAcc.nodeIds[0] as string, "att-core", "{}");
    runner.drain(10, optPorts);
    const reportPath = writeArtifact(`partial-${opt.runId}.md`, "# Report\n\nbody\n");
    runner.attemptSucceeded(opt.runId, optAcc.nodeIds[2] as string, "att-optw", JSON.stringify({ artifact: reportPath }));
    runner.drain(10, optPorts);
    expect(runner.submitVerdict(opt.runId, optAcc.nodeIds[3] as string, { verdict: "accept" })).toBe("accepted");
    const sender = { name: "synth-sender", send: (_doc: { idempotenceKey: string }) => "receipt" };
    expect(runner.executeDelivery(opt.runId, optAcc.nodeIds[3] as string, sender)).toBe("acknowledged");
    expect(store.getRun(opt.runId)?.state).toBe("succeeded");
    // The optional failure is preserved evidence, never hidden by the accept.
    const extraNode = store.listNodes(opt.runId, 1).find((n) => n["node_id"] === optAcc.nodeIds[1]);
    expect(extraNode?.["status"]).toBe("failed");

    // Required lane failure settles explicitly: dependents never run, the run
    // fails with its cause, and audit reports no ownerless residue.
    const req = admitScheduled(runner, store, "partial-required");
    const reqAcc = runner.acceptPlan(req.runId, lanesPlusWriter());
    const reqDispatched: string[] = [];
    runner.drain(10, scriptedPorts(reqDispatched));
    runner.attemptFailed(req.runId, reqAcc.nodeIds[0] as string, "att-hard", "hard down", false);
    runner.attemptFailed(req.runId, reqAcc.nodeIds[1] as string, "att-hard-b", "hard down", false);
    expect(store.getRun(req.runId)?.state).toBe("failed");
    expect(store.getRun(req.runId)?.failureCode).toBe("node_failed");
    expect(reqDispatched).not.toContain(reqAcc.nodeIds[2]);
    expect(runner.auditTick(0).ownerless).not.toContain(req.runId);
  });
});
