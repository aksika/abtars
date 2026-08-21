/**
 * orc-intent-turn.test.ts — #1680 Task 1 production-shaped regression at the
 * escaped turn boundary: a contract-authoring Orc turn whose provider keeps
 * calling tools after `define_project_contract` commits must terminate at the
 * durable transition, release the exact run as completed with no failure code,
 * and let Reconciler select `contribution_wait` without creating a
 * `project_execution` continuation.
 *
 * Real: Spin, Orc coordinator, run store, task database, tool registry,
 * contract tool, and Reconciler composition. Only the provider responses are
 * faked (the session transport's sendPrompt).
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

async function seedPeerProjectWithContribution(): Promise<number> {
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
  return rootId;
}

const CONTRACT_ARGS = (projectCardId: number): Record<string, string> => ({
  project_card_id: String(projectCardId),
  goal: "supervised peer work",
  criteria: JSON.stringify([{ id: "c1", description: "Task goal met", required: true, execution_owner: "delegated", evidence_expectation: "synthesis" }]),
  required_outputs: JSON.stringify([]),
  constraints: JSON.stringify([]),
});

function mockTransport(scripted: (ctx: import("../transport/kiro-transport.js").PromptRequestContext | undefined) => Promise<string>) {
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
  it("commits the contract, terminates the turn at the durable intent, and selects contribution_wait without a continuation", async () => {
    const toolAttempts: string[] = [];
    const transport = mockTransport(async (ctx) => {
      const bound = ctx?.orcContext;
      const control = ctx?.orcTurnControl;
      expect(bound).toBeDefined();
      expect(control).toBeDefined();
      // 1. the provider authors the contract through the REAL registry/tool.
      const contractResult = await toolRegistry.executeToolCall("define_project_contract", CONTRACT_ARGS(bound!.projectCardId), {
        userId: "test-user", orcContext: bound, orcTurnControl: control, authorizationMode: "interactive",
      });
      toolAttempts.push("define_project_contract");
      expect(contractResult).toContain("Root contract defined");

      // 2a. schema presentation: the authoring surface must not expose the
      // broad second tool.
      const safety = piCoreSafetyMod.createPiExecutionSafetyController(
        new fallbackPolicyMod.FallbackPolicy([] as never),
      );
      const tools = piCoreToolsMod.createPiAgentTools({
        executionId: "exec_1",
        userId: "test-user",
        sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
        safety,
        orcContext: bound,
      } as never);
      expect(tools.map(t => t.name)).toEqual(["define_project_contract"]);

      // 2b. a forged/stale direct call is rejected at the execution gate.
      const bashResult = await toolRegistry.executeToolCall("execute_bash", { command: "echo escape" }, {
        userId: "test-user", orcContext: bound, orcTurnControl: control, authorizationMode: "interactive",
      });
      toolAttempts.push("execute_bash");
      const parsed = JSON.parse(bashResult) as { error?: string; reason?: string };
      expect(parsed.error).toBeDefined();
      expect(parsed.reason).toBe("orc_intent_surface");

      // 3. the durable intent already completed the host-owned control.
      expect(control!.completed).toMatchObject({ kind: "intent_satisfied", code: "contract_defined" });
      return contractResult;
    });

    const spin = new spinMod.Spin();
    spin.setRuntime({ session: vi.fn(async () => ({ transport, destroy: vi.fn() })), openExecution: vi.fn(), lastUsage: null } as never);

    const coordinator = new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "kp",
      ownerInstanceId: "inst-test",
      startPort: async (spec) => {
        spin.spin({
          type: "O",
          goal: spec.goal,
          sessionId: spec.context.sessionId,
          cardId: spec.context.projectCardId,
          settlementOwner: "spin",
          source: "agent",
          orcContext: spec.context,
          orcTurnControl: spec.turnControl,
          orcMaxPromptRounds: spec.maxPromptRounds,
          await: false,
        }).catch((err: unknown) => console.log("DBG spin error:", err instanceof Error ? err.stack : String(err)));
      },
    });

    const rootId = await seedPeerProjectWithContribution();
    await startGeneration(coordinator);

    // The boot wake claims the authoring run and starts the real Spin turn.
    await flush(8);

    const runStore = new runStoreMod.OrcProjectRunStore();
    const runs = runStore.getRunsForProject(rootId);
    const authoring = runs.find(r => r.intent_kind === "contract_authoring");
    expect(authoring).toBeDefined();
    expect(authoring!.state).toBe("released");
    expect(authoring!.outcome).toBe("completed");
    expect(authoring!.failure_code).toBeNull();

    // The durable postcondition was re-read, not taken from the tool string.
    const supervision = new reviewStoreMod.ProjectReviewStore().getSupervision(rootId);
    expect(supervision?.state).toBe("executing");
    const snapshot = policyMod.readOrcProjectSnapshot(runStore.db, rootId);
    expect(snapshot.contractExists).toBe(true);
    expect(snapshot.contributionActive).toBe(true);

    // Exactly the escaped tool sequence ran, and the second call was denied.
    expect(toolAttempts).toEqual(["define_project_contract", "execute_bash"]);

    // Wake the project again: the accepted contribution owns the root as
    // contribution_wait — no continuation claim, no project_execution run.
    reconciler.requestReconcile(rootId);
    await flush(6);
    expect(runStore.getLiveRunForProject(rootId)).toBeUndefined();
    const runsAfter = runStore.getRunsForProject(rootId);
    expect(runsAfter.filter(r => r.intent_kind === "project_execution")).toHaveLength(0);
    expect(runsAfter.filter(r => r.intent_kind === "contract_authoring")).toHaveLength(1);
  });

  it("a genuinely actionable live Orc claim outranks contribution_wait, and its consumed release hands off to the wait owner", async () => {
    const rootId = await seedPeerProjectWithContribution();
    const runStore = new runStoreMod.OrcProjectRunStore();
    const claim = runStore.claimIntent({
      projectCardId: rootId,
      intentKind: "contract_authoring",
      goal: "authoring claim",
      originKind: "peer",
      originPeer: "p1",
      cardSource: "peer",
      sourcePeer: "p1",
    }, "kp", "inst-test");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    const context = claim.context;
    const control = coordinatorMod.createOrcTurnControl(context.runId, () => true);
    runStore.promoteRun(context.runId);
    const bound = { ...context, sessionId: "sess_1", executionId: "exec_1" };
    const bind = runStore.bindExecution(bound, "sess_1", "exec_1");
    expect(bind.ok).toBe(true);

    // A live claim is an existing owner; commit the contract through the REAL
    // tool so the policy postcondition re-read wins the control.
    const contractResult = await toolRegistry.executeToolCall("define_project_contract", CONTRACT_ARGS(rootId), {
      userId: "test-user", orcContext: bound, orcTurnControl: control, authorizationMode: "interactive",
    });
    expect(contractResult).toContain("Root contract defined");
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
    const late = JSON.parse(await toolRegistry.executeToolCall("define_project_contract", {}, {
      userId: "test-user", orcContext: bound, authorizationMode: "interactive",
    })) as { reason?: string };
    expect(late.reason).toBe("orc_context_invalid");

    // A still-actionable live row would outrank the wait owner (orc_claim);
    // once consumed, the accepted contribution wins the wake.
    expect(policyMod.readOrcProjectSnapshot(runStore.db, rootId).contributionActive).toBe(true);
  });

  it("a normal local no-owner project claims exactly one project_execution run, never another contract_authoring run (#1680)", async () => {
    // Local executing root with a contract and no Worker/contribution/review
    // owner: the reconciler's no-owner path must claim the truthful
    // project_execution intent — never a second contract_authoring claim.
    const rootId = kanban.kanbanEnqueue("Local Project", "agent", undefined, {
      type: "O",
      goal: "local supervised work",
    });
    kanban.kanbanRunning(rootId);
    const store = new reviewStoreMod.ProjectReviewStore();
    const contractId = `ct_exec_${rootId}`;
    store.insertContract({
      schema_version: 2,
      id: contractId,
      digest: `d_${contractId}`,
      project_card_id: rootId,
      goal: "local supervised work",
      criteria: [{ id: "c1", description: "goal met", required: true, execution_owner: "orc", evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 10, max_repair_rounds: 5 },
      provenance: { requested_by: "agent", authored_by: "fixture", created_at: new Date().toISOString() },
    } as never);
    store.initializeSupervision(rootId, contractId, "executing");

    const runStore = new runStoreMod.OrcProjectRunStore();
    // The no-owner wake path (claimOrcContinuation) routes to
    // scheduleProjectExecution — the same decision the reconciler makes.
    const claim = new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "kp",
      ownerInstanceId: "inst-test",
      startPort: async () => {},
    }).scheduleProjectExecution(rootId, "resume from durable state");

    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(claim.context.intentKind).toBe("project_execution");
    expect(claim.context.intentKey).toBe(`execute:${rootId}:1`);
    const row = runStore.getRun(claim.context.runId);
    expect(row?.intent_kind).toBe("project_execution");

    // A second no-owner wake is idempotent against the same run — no second
    // claim, and never a contract_authoring claim (that intent is only
    // actionable before a contract exists).
    const again = new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "kp",
      ownerInstanceId: "inst-test",
      startPort: async () => {},
    }).scheduleProjectExecution(rootId, "resume from durable state");
    expect(again.kind).toBe("idempotent");
    expect(again.context.runId).toBe(claim.context.runId);
    expect(runStore.getRunsForProject(rootId).filter(r => r.intent_kind === "contract_authoring")).toHaveLength(0);
    expect(runStore.getRunsForProject(rootId).filter(r => r.intent_kind === "project_execution")).toHaveLength(1);
  });
});
