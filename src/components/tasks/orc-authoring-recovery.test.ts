/**
 * orc-authoring-recovery.test.ts — #1628 Task 8 end-to-end lifecycle coverage
 * at the coordinator/reconciler boundary with real SQLite stores. Only the
 * Orc start port is scripted; the kanban, supervision, and run tables are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The reconciler's created coordinator starts Orc turns through spin.spin.
// Mocked so getOrCreateOrcCoordinator can build a REAL coordinator in tests
// (race 2 needs the boot-recovery path that only runs on coordinator creation).
vi.mock("../spin.js", () => ({
  spin: { spin: vi.fn(), dispatch: vi.fn(), spawnChild: vi.fn() },
}));

let TEST_HOME: string;
let kanban: typeof import("./kanban-board.js");
let requireTaskDatabase: typeof import("./kanban-board.js").requireTaskDatabase;
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let reconciler: typeof import("../reconciler.js");
let runStoreMod: typeof import("../orc-project/orc-project-run-store.js");
let coordinatorMod: typeof import("../orc-project/orc-project-coordinator.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-authoring-recovery-"));
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  // race 2 lets getOrCreateOrcCoordinator build a real coordinator, which
  // reads the peer identity — bootstrap the config dir like boot would.
  mkdirSync(join(TEST_HOME, "config"), { recursive: true });
  writeFileSync(join(TEST_HOME, "config", "peers.json"), JSON.stringify({
    self: { name: "kp", signingKey: "k".repeat(64), tribeToken: "t".repeat(32) },
    peers: {},
  }));
  kanban = await import("./kanban-board.js");
  requireTaskDatabase = (await import("./kanban-board.js")).requireTaskDatabase;
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  reconciler = await import("../reconciler.js");
  runStoreMod = await import("../orc-project/orc-project-run-store.js");
  coordinatorMod = await import("../orc-project/orc-project-coordinator.js");
});

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  wakeScheduler?.stop();
  wakeScheduler = null;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 20));
}

interface SeedOpts {
  cardStatus?: "queued" | "running";
  source?: "task" | "peer" | "agent";
  sourceId?: string;
  sourcePeer?: string;
  notes?: Record<string, unknown>;
  state?: string;
  goal?: string;
}

async function seedProject(opts: SeedOpts = {}): Promise<number> {
  const rootId = kanban.kanbanEnqueue(opts.source === "task" ? "Scheduled Project" : "Project", opts.source ?? "agent", opts.sourceId, {
    type: "O",
    goal: opts.goal ?? "supervised work",
    notes: opts.notes ? JSON.stringify(opts.notes) : undefined,
    sourcePeer: opts.sourcePeer,
  });
  const store = new reviewStoreMod.ProjectReviewStore();
  store.initializeSupervision(rootId, `ct_${rootId}`, (opts.state as never) ?? "awaiting_contract");
  if (opts.cardStatus === "queued") {
    kanban._kanbanExecForTest(
      `UPDATE kanban_board SET status = 'queued', next_retry_at = ? WHERE id = ?`,
      [new Date(Date.now() - 1000).toISOString(), rootId],
    );
  } else {
    kanban.kanbanRunning(rootId);
  }
  return rootId;
}

/** Direct-run seeding (immutable rows, distinct ownership generations). */
function seedRun(
  cardId: number,
  generation: number,
  opts: { started?: boolean; state?: string; createdAt?: string; ownerInstance?: string } = {},
): void {
  const store = new runStoreMod.OrcProjectRunStore();
  const now = new Date().toISOString();
  const runId = `or_seed_${cardId}_${Math.random().toString(36).slice(2, 10)}`;
  store.db.prepare(`
    INSERT INTO orc_project_runs
      (id, intent_key, intent_kind, intent_ref, project_card_id,
       project_generation, ownership_generation, owner_peer, owner_instance_id,
       origin_kind, origin_peer, state, outcome, failure_code, created_at, started_at, released_at, updated_at)
    VALUES (?, ?, 'contract_authoring', NULL, ?, ?, ?, 'kp', ?, 'local', NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    `contract:${cardId}:${generation}`,
    cardId, generation,
    Math.floor(Math.random() * 1_000_000) + 1,
    opts.ownerInstance ?? "inst-test",
    opts.state ?? "released",
    "failed",
    null,
    opts.createdAt ?? now,
    opts.started ? now : null,
    opts.started ? now : null,
    now,
  );
}

function makeCoordinator(startPort: (ctx: unknown, goal: string) => Promise<void>): InstanceType<typeof coordinatorMod.OrcProjectCoordinator> {
  return new coordinatorMod.OrcProjectCoordinator({
    ownerPeer: "kp",
    ownerInstanceId: "inst-test",
    startPort: startPort as never,
  });
}


let activeHandle: import("../reconciler.js").ReconcilerHandle | null = null;
let wakeScheduler: import("../lifecycle-wake-scheduler.js").LifecycleWakeScheduler | null = null;

/** #1554: start a real generation over the tmpdir stores with the given coordinator. */
async function startGeneration(coordinator: InstanceType<typeof coordinatorMod.OrcProjectCoordinator>): Promise<void> {
  const { LifecycleWakeScheduler } = await import("../lifecycle-wake-scheduler.js");
  const { SpinWorkerAdapter } = await import("../spin-worker-adapter.js");
  const { ReconcileQuarantineStore } = await import("../reconcile-quarantine-store.js");
  await activeHandle?.stop();
  activeHandle = null;
  wakeScheduler?.stop();
  wakeScheduler = new LifecycleWakeScheduler();
  activeHandle = await reconciler.startReconciler({
    generationId: `orc-recovery-${Date.now()}`,
    coordinator,
    wakeScheduler,
    workerAdapter: new SpinWorkerAdapter(),
    piService: null,
    createPiAdapter: (() => ({ kind: "pi", capacity: async () => ({ available: 0, max: 0 }), start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }), cancel: async () => ({ kind: "cancelled", attemptId: "" }), inspect: async () => ({ kind: "running", lifecycle: "running" }) })) as never,
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: () => {},
  } as never);
  await wakeScheduler.start();
}

describe("#1628 Orc authoring recovery (real stores)", () => {
  it("race 1: a busy claim from card:queued is dropped and the post-release event produces a fresh claim", async () => {
    const starts: Array<{ runId: string }> = [];
    const coordinator = makeCoordinator(async (ctx: { runId: string }) => { starts.push(ctx); });
    const rootId = await seedProject({ cardStatus: "queued" });
    await startGeneration(coordinator);
    const runStore = new runStoreMod.OrcProjectRunStore();

    // wake 1 (the stranded sweep at boot): claim, run stays live (start port succeeds)
    await flush();
    expect(runStore.getLiveRuns()).toHaveLength(1);
    const run1 = runStore.getLiveRuns()[0]!;

    // backdate run1 so the claim interval does not defer the busy wake
    runStore.db.prepare(`UPDATE orc_project_runs SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 10_000).toISOString(), run1.id);

    // wake 2 while the run is still live (the card:queued-before-release race):
    // the claim is busy and dropped — no second run
    reconciler.requestReconcile(rootId);
    await flush();
    expect(runStore.getLiveRuns()).toHaveLength(1);
    expect(runStore.getLiveRuns()[0]!.id).toBe(run1.id);

    // the failed turn releases through the coordinator → event → re-wake →
    // a FRESH claim, not busy
    const bound = { ...starts[0]!, sessionId: "sess_1", executionId: "exec_1" };
    expect(coordinator.releaseOwnedRun(bound as never, "failed")).toBe(true);
    await flush();
    await flush();

    const live = runStore.getLiveRuns();
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(run1.id);
    expect(runStore.getRun(run1.id)!.state).toBe("released");
  });

  it("race 2: boot supersession of an unbound run reclaims the queued root after listener registration", async () => {
    const rootId = await seedProject({ cardStatus: "queued" });
    const runStore = new runStoreMod.OrcProjectRunStore();

    // a live foreign-instance run predates this boot
    const foreign = runStore.claimIntent(
      { projectCardId: rootId, intentKind: "contract_authoring", originKind: "local", cardSource: "agent", sourcePeer: null },
      "other-peer", "other-instance",
    );
    expect(foreign.kind).toBe("claimed");
    if (foreign.kind !== "claimed") return;
    runStore.db.prepare(`UPDATE orc_project_runs SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), foreign.context.runId);

    // #1554: the generation owns the coordinator and runs boot recovery
    // exactly once at start; the recovered projects are woken after the
    // listeners are registered (spin is mocked, so the claim starts harmlessly).
    await startGeneration(makeCoordinator(async () => {}));

    await flush();
    await flush();

    expect(runStore.getRun(foreign.context.runId)!.state).toBe("superseded");
    const live = runStore.getLiveRuns();
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(foreign.context.runId);
  });

  it("durability: the boot sweep alone recovers a stranded queued root with no event path", async () => {
    const rootId = await seedProject({ cardStatus: "queued" });
    await startGeneration(makeCoordinator(async () => {}));
    // project 63's exact state: only run already superseded, no live run, no events
    seedRun(rootId, 1, { started: false, createdAt: new Date(Date.now() - 600_000).toISOString(), state: "superseded" });
    const runStore = new runStoreMod.OrcProjectRunStore();

    const count = reconciler.scanActiveProjects();
    expect(count).toBeGreaterThanOrEqual(1);
    await flush();
    await flush();

    const live = runStore.getLiveRuns();
    expect(live).toHaveLength(1);
    expect(live[0]!.project_card_id).toBe(rootId);
    expect(live[0]!.state).toBe("dispatching");
  });

  it("durability: the sweep excludes accepted/blocked supervision and terminal kanban statuses", async () => {
    const acceptedId = await seedProject({ cardStatus: "queued", state: "accepted" });
    const blockedId = await seedProject({ cardStatus: "queued", state: "blocked" });
    const doneId = await seedProject({ cardStatus: "running", state: "awaiting_contract" });
    kanban.kanbanComplete(doneId, null, "done");
    const runStore = new runStoreMod.OrcProjectRunStore();

    reconciler.scanActiveProjects();
    await flush();
    await flush();

    expect(runStore.getLiveRuns()).toHaveLength(0);
    expect(runStore.getRunsForProject(acceptedId)).toHaveLength(0);
    expect(runStore.getRunsForProject(blockedId)).toHaveLength(0);
    expect(runStore.getRunsForProject(doneId)).toHaveLength(0);
  });

  it("budget: an unstarted stale claim does not spend the started-turn budget", async () => {
    const rootId = await seedProject({ cardStatus: "queued" });
    await startGeneration(makeCoordinator(async () => {}));
    seedRun(rootId, 1, { started: false, createdAt: new Date(Date.now() - 300_000).toISOString(), state: "superseded" });
    const runStore = new runStoreMod.OrcProjectRunStore();

    reconciler.requestReconcile(rootId);
    await flush();
    await flush();

    expect(runStore.getLiveRuns()).toHaveLength(1); // a fresh claim still happens
    expect(runStore.countStartedAuthoringTurns(rootId, 1)).toBe(0);
  });

  it("exhaustion: three started unsuccessful turns settle blocked once with no fourth turn", async () => {
    const rootId = await seedProject({ cardStatus: "queued" });
    await startGeneration(makeCoordinator(async () => {}));
    const old = new Date(Date.now() - 600_000).toISOString();
    seedRun(rootId, 1, { started: true, createdAt: old });
    seedRun(rootId, 1, { started: true, createdAt: old });
    seedRun(rootId, 1, { started: true, createdAt: old });
    const runStore = new runStoreMod.OrcProjectRunStore();
    const before = runStore.getRunsForProject(rootId).length;

    reconciler.requestReconcile(rootId);
    await flush();
    await flush();

    const supervision = new reviewStoreMod.ProjectReviewStore().getSupervision(rootId)!;
    expect(supervision.state).toBe("blocked");
    expect(supervision.blocked_reason).toBe("contract_authoring_exhausted");
    expect(kanban.kanbanGetCard(rootId)!.status).toBe("failed");
    expect(runStore.getRunsForProject(rootId)).toHaveLength(before); // no fourth turn
    expect(runStore.getLiveRuns()).toHaveLength(0);
  });

  it("unstartable: three consecutive pre-start failures settle blocked and terminate the wake loop", async () => {
    const rootId = await seedProject({ cardStatus: "queued" });
    await startGeneration(makeCoordinator(async () => {}));
    seedRun(rootId, 1, { started: false });
    seedRun(rootId, 1, { started: false });
    seedRun(rootId, 1, { started: false });
    const runStore = new runStoreMod.OrcProjectRunStore();
    const before = runStore.getRunsForProject(rootId).length;

    reconciler.requestReconcile(rootId);
    await flush();
    await flush();

    const supervision = new reviewStoreMod.ProjectReviewStore().getSupervision(rootId)!;
    expect(supervision.state).toBe("blocked");
    expect(supervision.blocked_reason).toBe("contract_authoring_unstartable");

    // a repeating wake must not spin: still blocked, still no new runs
    reconciler.requestReconcile(rootId);
    await flush();
    expect(runStore.getRunsForProject(rootId)).toHaveLength(before);
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(rootId)!.state).toBe("blocked");
  });

  it("idempotency: a peer root produces exactly one failed outbox event under duplicate wakes", async () => {
    const rootId = await seedProject({
      cardStatus: "queued",
      source: "peer",
      sourcePeer: "kp",
      notes: { request_id: "req_peer_1", contribution_ref: "ref_peer_1" },
    });
    await startGeneration(makeCoordinator(async () => {}));
    const old = new Date(Date.now() - 600_000).toISOString();
    seedRun(rootId, 1, { started: true, createdAt: old });
    seedRun(rootId, 1, { started: true, createdAt: old });
    seedRun(rootId, 1, { started: true, createdAt: old });

    reconciler.requestReconcile(rootId);
    await flush();
    reconciler.requestReconcile(rootId); // duplicate wake
    await flush();
    await flush();

    const store = new reviewStoreMod.ProjectReviewStore();
    const outbox = store.getPendingAcceptanceOutbox(100).filter(r => r.project_card_id === rootId);
    expect(outbox).toHaveLength(1);
    const { parseContributionEvent, contributionEventDigest } = await import("../peer-help/contract.js");
    const { ContributionStore } = await import("../peer-help/contribution-store.js");
    const parsed = parseContributionEvent(JSON.parse(outbox[0]!.payload_json));
    expect(parsed.ok).toBe(true); // #1630 auto-derived a requester-valid event
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("failed");

    // #1628 Task 7 verify (updated): the payload must be accepted by the
    // requester — assert applyEvent returns "applied", not merely non-null.
    const contributions = new ContributionStore(requireTaskDatabase(), {
      kanbanGetCard: () => undefined,
      kanbanUpdate: () => {},
      kanbanComplete: () => {},
      kanbanFail: () => {},
    } as never);
    const reserve = contributions.reserve("kp", "req_peer_1", "hash_peer_1", null, null, null);
    expect(reserve.status).toBe("new");
    contributions.adoptContributionRef("kp", "req_peer_1", "ref_peer_1");
    expect(contributions.transitionToAccepted("kp", "req_peer_1")).toBe(true);

    const applied = contributions.applyEvent(
      "kp",
      parsed.value,
      contributionEventDigest(parsed.value),
      JSON.stringify(parsed.value.projection),
    );
    expect(applied).toBe("applied");
    expect(contributions.getContribution("kp", "req_peer_1")!.state).toBe("failed");
  });

  it("happy path: a persisted contract proceeds normally regardless of the attempt count", async () => {
    const rootId = await seedProject({ cardStatus: "running", state: "executing" });
    await startGeneration(makeCoordinator(async () => {}));
    const old = new Date(Date.now() - 600_000).toISOString();
    seedRun(rootId, 1, { started: true, createdAt: old });
    seedRun(rootId, 1, { started: true, createdAt: old });
    seedRun(rootId, 1, { started: true, createdAt: old });
    const store = new reviewStoreMod.ProjectReviewStore();
    store.insertContract({
      schema_version: 1,
      id: `ct_${rootId}`,
      digest: `dg_${rootId}`,
      project_card_id: rootId,
      goal: "supervised work",
      criteria: [{ id: "c1", description: "goal met", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: {},
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    });

    reconciler.requestReconcile(rootId);
    await flush();
    await flush();

    const supervision = store.getSupervision(rootId)!;
    expect(supervision.state).not.toBe("blocked");
    expect(supervision.blocked_reason).toBeNull();
    expect(kanban.kanbanGetCard(rootId)!.status).not.toBe("failed");
  });

  it("negative: accepted/blocked/reviewing supervision is never reawakened into authoring", async () => {
    const acceptedId = await seedProject({ cardStatus: "running", state: "accepted" });
    const blockedId = await seedProject({ cardStatus: "running", state: "blocked" });
    // #1628 Task 8: a reviewing project with a contract must not enter the
    // contract-authoring branch — no authoring claim goal, no exhaustion
    // settlement. (#1516 continuations reuse the contract_authoring intent
    // kind but carry the resume goal; the branch itself is what is forbidden.)
    const reviewingId = await seedProject({ cardStatus: "running", state: "reviewing" });
    const reviewStore = new reviewStoreMod.ProjectReviewStore();
    reviewStore.insertContract({
      schema_version: 1,
      id: `ct_review_${reviewingId}`,
      digest: `dg_${reviewingId}`,
      project_card_id: reviewingId,
      goal: "supervised work",
      criteria: [{ id: "c1", description: "goal met", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: {},
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    });
    await startGeneration(makeCoordinator(async () => {}));
    const runStore = new runStoreMod.OrcProjectRunStore();

    reconciler.requestReconcile(acceptedId);
    reconciler.requestReconcile(blockedId);
    reconciler.requestReconcile(reviewingId);
    await flush();
    await flush();

    expect(runStore.getRunsForProject(acceptedId)).toHaveLength(0);
    expect(runStore.getRunsForProject(blockedId)).toHaveLength(0);
    const supervision = reviewStore.getSupervision(reviewingId)!;
    expect(supervision.state).toBe("reviewing");
    expect(supervision.blocked_reason).toBeNull();
    expect(kanban.kanbanGetCard(reviewingId)!.status).toBe("running");
  });

  it("a conflicted authoring claim never promotes and never settles", async () => {
    // A peer root without an authenticated source peer cannot derive an
    // origin — scheduleContractAuthoring conflicts with origin_invalid.
    const rootId = await seedProject({ cardStatus: "queued", source: "peer", sourcePeer: undefined });
    await startGeneration(new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "kp",
      ownerInstanceId: "inst-test",
      getRootIdentity: () => ({ source: "peer", sourcePeer: null }),
      startPort: async () => {},
    }));
    const runStore = new runStoreMod.OrcProjectRunStore();

    reconciler.requestReconcile(rootId);
    await flush();
    await flush();

    // nothing was claimed (no run row), nothing was settled (still awaiting
    // contract), and the card was not promoted by a phantom "idempotent".
    expect(runStore.getRunsForProject(rootId)).toHaveLength(0);
    const supervision = new reviewStoreMod.ProjectReviewStore().getSupervision(rootId)!;
    expect(supervision.state).toBe("awaiting_contract");
    expect(supervision.blocked_reason).toBeNull();
  });
});
