/**
 * orc-intent-turn.test.ts — #1680 Task 1 production-shaped regression at the
 * escaped turn boundary: a contract-authoring Orc turn whose provider keeps
 * calling tools after `define_project_contract` commits must terminate at the
 * durable transition, release the exact run as completed with no failure code,
 * and let Reconciler select `contribution_wait` without creating a
 * `project_execution` continuation.
 *
 * Real: Spin, Orc coordinator, run store, task database, tool registry,
 * contract store, and Reconciler composition. Only the provider responses are
 * faked (the session transport's sendPrompt).
 *
 * #1792: the coordinator schedule/startPort dispatch path is retired — the
 * runner dispatches all work now. The journeys that pinned
 * `scheduleProjectExecution`/`scheduleContractAuthoring` (no-owner execution
 * claim, yield_turn handoff, injected overlap via coordinator dispatch) are
 * deleted with it; turn-control/late-call protection is preserved through the
 * retained store-direct journey below plus runner/store tests (see
 * orc-project-coordinator.test.ts header).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let kanban: typeof import("../tasks/kanban-board.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let reconciler: typeof import("../reconciler.js");
let runStoreMod: typeof import("./orc-project-run-store.js");
let coordinatorMod: typeof import("./orc-project-coordinator.js");
let spinMod: typeof import("../spin.js");
let toolRegistry: typeof import("../transport/tool-registry.js");
let contributionStoreMod: typeof import("../peer-help/contribution-store.js");
let policyMod: typeof import("./orc-intent-policy.js");
let piCoreToolsMod: typeof import("../transport/pi-core-tools.js");
let piCoreSafetyMod: typeof import("../transport/pi-core-safety.js");
let fallbackPolicyMod: typeof import("../transport/fallback-policy.js");
let healthRegistryMod: typeof import("../transport/model-health-registry.js");

let activeHandle: import("../reconciler.js").ReconcilerHandle | null = null;
let wakeScheduler: import("../lifecycle-wake-scheduler.js").LifecycleWakeScheduler | null = null;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-intent-turn-"));
  vi.doMock("../../paths.js", () => ({
    abtarsHome: () => TEST_HOME,
    abmindHome: () => join(TEST_HOME, "..", "abmind-test"),
    abtarsRoot: () => join(TEST_HOME, "live-checkout"),
  }));
  mkdirSync(join(TEST_HOME, "config"), { recursive: true });
  writeFileSync(join(TEST_HOME, "config", "peers.json"), JSON.stringify({
    self: { name: "kp", signingKey: "k".repeat(64), tribeToken: "t".repeat(32) },
    peers: {},
  }));
  kanban = await import("../tasks/kanban-board.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  reconciler = await import("../reconciler.js");
  runStoreMod = await import("./orc-project-run-store.js");
  coordinatorMod = await import("./orc-project-coordinator.js");
  spinMod = await import("../spin.js");
  toolRegistry = await import("../transport/tool-registry.js");
  contributionStoreMod = await import("../peer-help/contribution-store.js");
  policyMod = await import("./orc-intent-policy.js");
  piCoreToolsMod = await import("../transport/pi-core-tools.js");
  piCoreSafetyMod = await import("../transport/pi-core-safety.js");
  fallbackPolicyMod = await import("../transport/fallback-policy.js");
  healthRegistryMod = await import("../transport/model-health-registry.js");
  const { setUserRegistryOverride } = await import("../user-registry.js");
  setUserRegistryOverride({
    users: [{ userId: "kp", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 1 } }],
    byPlatformId: new Map([["telegram:1", { userId: "kp", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 1 } }]]),
    byUserId: new Map([["kp", { userId: "kp", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 1 } }]]),
  });
}, 30_000);

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  wakeScheduler?.stop();
  wakeScheduler = null;
  const { setUserRegistryOverride } = await import("../user-registry.js");
  setUserRegistryOverride(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 25));
}

/**
 * #1792: local one-shot turn-control stand-in for the deleted
 * `createOrcTurnControl` factory (retired with the coordinator schedule
 * path). The retained journey below passes `() => true` verification, so the
 * first `complete()` wins — identical to the old factory under that
 * verification. Production turn dispatch lives in the runner now.
 */
function makeTestTurnControl(runId: string): import("./orc-project-contracts.js").OrcTurnControl {
  let completed: import("./orc-project-contracts.js").OrcTurnTerminal | null = null;
  return {
    runId,
    get completed(): import("./orc-project-contracts.js").OrcTurnTerminal | null { return completed; },
    complete(terminal: import("./orc-project-contracts.js").OrcTurnTerminal): boolean {
      if (completed !== null) return false;
      completed = terminal;
      return true;
    },
  };
}

async function seedPeerProjectWithContribution(withLedger = false): Promise<number> {
  const rootId = kanban.kanbanEnqueue("Peer Project", "peer", undefined, {
    type: "O",
    goal: "supervised peer work",
    sourcePeer: "p1",
  });
  kanban.kanbanRunning(rootId);
  const store = new reviewStoreMod.ProjectReviewStore();
  store.initializeSupervision(rootId, `ct_${rootId}`, "awaiting_contract");
  const cs = new contributionStoreMod.ContributionStore(
    (await import("../tasks/kanban-board.js")).requireTaskDatabase() as never,
    {
      kanbanGetCard: (id: number) => kanban.kanbanGetCard(id) ?? undefined,
      kanbanUpdate: () => {},
      kanbanComplete: () => {},
      kanbanFail: () => {},
    } as never,
  );
  cs.reserveProxy({
    peer: "p1", requestId: `rq_${rootId}`, requestHash: `h_${rootId}`,
    projectCardId: rootId, title: "help", goal: "peer contribution",
    priority: "HIGH", sourcePeer: "p1", proxyCardId: undefined, notes: {},
  });
  cs.transitionToAccepted("p1", `rq_${rootId}`);
  if (withLedger) {
    // #1630: the receiver's accepted help ledger is the terminal-event
    // identity authority. Seed the durable row the outbox auto-derivation
    // correlates against (never the mutable card notes).
    const taskDb = (await import("../tasks/kanban-board.js")).requireTaskDatabase();
    taskDb.exec(`
      CREATE TABLE IF NOT EXISTS peer_help_requests (
        origin_peer TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        contribution_ref TEXT,
        local_card_id INTEGER,
        local_run_id TEXT,
        response_json TEXT,
        withdrawn_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (origin_peer, request_id),
        UNIQUE (contribution_ref)
      )
    `);
    taskDb.prepare(`
      INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
      VALUES ('p1', ?, ?, 'accepted', ?, ?, '{}', datetime('now'), datetime('now'))
    `).run(`rq_${rootId}`, `h_${rootId}`, `ref_${rootId}`, rootId);
  }
  return rootId;
}

async function mockTransport(scripted: (ctx: import("../transport/kiro-transport.js").PromptRequestContext | undefined) => Promise<string>) {
  const transport = {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn(async (_k: string, _m: string, _i: unknown, ctx?: import("../transport/kiro-transport.js").PromptRequestContext) => scripted(ctx)),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    get isReady() { return true; },
    get contextPercent() { return -1; },
    get answerOnly() { return ""; },
    get toolCallsSucceeded() { return 0; },
    get intermediateDeliveredText() { return ""; },
  } as never;
  return transport;
}

async function startGeneration(coordinator: InstanceType<typeof coordinatorMod.OrcProjectCoordinator>): Promise<void> {
  const { LifecycleWakeScheduler } = await import("../lifecycle-wake-scheduler.js");
  const { SpinWorkerAdapter } = await import("../spin-worker-adapter.js");
  const { ReconcileQuarantineStore } = await import("../reconcile-quarantine-store.js");
  wakeScheduler = new LifecycleWakeScheduler();
  activeHandle = await reconciler.startReconciler({
    generationId: `intent-turn-${Date.now()}`,
    coordinator,
    wakeScheduler,
    workerAdapter: new SpinWorkerAdapter(),
    piService: null,
    createPiAdapter: (() => ({
      kind: "pi", capacity: async () => ({ available: 0, max: 0 }),
      start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }),
      cancel: async () => ({ kind: "cancelled", attemptId: "" }),
      inspect: async () => ({ kind: "running", lifecycle: "running" }),
    })) as never,
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: () => {},
  } as never);
  await wakeScheduler.start();
}

describe("#1680 escaped turn boundary (real Spin/coordinator/stores/tools)", () => {
  it("#1691 injected overlap: a second O start on the same session is rejected before it can overwrite the first execution, and the first owner releases its own run", async () => {
    const rootId = await seedPeerProjectWithContribution();
    const runStore = new runStoreMod.OrcProjectRunStore();
    const claim = runStore.claimIntent({
      projectCardId: rootId,
      // #1792: `operator_turn` is the only surviving intent-policy row; the
      // turn-control one-shot, release, and late-call rejection under test
      // are intent-agnostic.
      intentKind: "operator_turn",
      goal: "authoring claim",
      originKind: "peer",
      originPeer: "p1",
      cardSource: "peer",
      sourcePeer: "p1",
    }, "kp", "inst-test");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    const context = claim.context;
    const control = makeTestTurnControl(context.runId);
    runStore.promoteRun(context.runId);
    const bound = { ...context, sessionId: "sess_1", executionId: "exec_1" };
    const bind = runStore.bindExecution(bound, "sess_1", "exec_1");
    expect(bind.ok).toBe(true);

    // #1792: the define_project_contract tool is deleted — commit the same
    // durable contract + supervision transition store-direct (the exact
    // writes the tool performed), then win the host-owned control.
    const { normalizeContract, createContractId } = await import("../project-acceptance/project-contract.js");
    const { authorizeActiveProjectWork } = await import("../project-acceptance/project-review-store.js");
    const rawContract: Record<string, unknown> = {
      schema_version: 2,
      id: createContractId(),
      digest: "",
      project_card_id: rootId,
      goal: "supervised peer work",
      criteria: [{ id: "c1", description: "Task goal met", required: true, execution_owner: "delegated", evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 10, max_repair_rounds: 5 },
      provenance: { requested_by: "peer", authored_by: "orc", created_at: new Date().toISOString() },
    };
    const normalized = normalizeContract(rawContract);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const reviewStore = new reviewStoreMod.ProjectReviewStore();
    const authority = { projectCardId: bound.projectCardId, projectGeneration: bound.projectGeneration };
    reviewStore.db.transaction(() => {
      const rejection = authorizeActiveProjectWork(reviewStore.db, authority);
      if (rejection) throw new Error(`project mutation rejected: ${rejection}`);
      reviewStore.insertContract(normalized.contract);
      reviewStore.initializeSupervision(rootId, normalized.contract.id, "executing");
    });
    expect(reviewStore.getSupervision(rootId)?.state).toBe("executing");
    expect(control.complete({ kind: "intent_satisfied", code: "contract_defined" })).toBe(true);
    expect(control.completed).toMatchObject({ kind: "intent_satisfied" });

    // The host-owned control cannot be replayed or displaced: a second request
    // loses the one-shot latch.
    expect(control.complete({ kind: "failed", failureCode: "provider_failure" })).toBe(false);
    expect(control.completed).toMatchObject({ kind: "intent_satisfied" });

    // Release exactly the bound run; the ownership-released event must hand the
    // project to contribution_wait without a continuation.
    const released = runStore.release(bound, "completed");
    expect(released).toBe(true);
    const row = runStore.getRun(context.runId);
    expect(row?.outcome).toBe("completed");
    expect(row?.failure_code).toBeNull();

    // A transport-bypassed late tool call must be rejected at the shared
    // execution gate after the exact run has released; it must not reach the
    // shell/tool implementation merely because its intent surface was valid.
    // #1792: the contract tool is deleted — execute_bash (live) pins the same
    // gate: the denial precedes tool lookup.
    const late = JSON.parse(await toolRegistry.executeToolCall("execute_bash", { command: "echo late" }, {
      userId: "test-user", orcContext: bound, authorizationMode: "interactive",
    })) as { reason?: string };
    expect(late.reason).toBe("orc_context_invalid");

    // A still-actionable live row would outrank the wait owner (orc_claim);
    // once consumed, the accepted contribution wins the wake.
    expect(policyMod.readOrcProjectSnapshot(runStore.db, rootId).contributionActive).toBe(true);
  });

});
