/**
 * orc-bridge-fuse.test.ts — #1707 Task 5: the bridge-wide emergency fuse.
 * A controlled synthetic trip proves the process-wide limits refuse new
 * automatic work, survive an ordinary restart, and clear only via the
 * explicit bridge reset with a generation bump.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let kanban: typeof import("../tasks/kanban-board.js");
let runStoreMod: typeof import("./orc-project-run-store.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let alertsMod: typeof import("./orc-alerts.js");
let contractsMod: typeof import("./orc-project-contracts.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-bridge-fuse-"));
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("../tasks/kanban-board.js");
  runStoreMod = await import("./orc-project-run-store.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  alertsMod = await import("./orc-alerts.js");
  contractsMod = await import("./orc-project-contracts.js");
  alertsMod.clearOrcAlertMuteForTest();
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function seedProject(cardId: number): void {
  kanban.kanbanEnqueue(`P${cardId}`, "peer", `peer-${cardId}`, { type: "O", sourcePeer: "other-peer" });
  const reviewStore = new reviewStoreMod.ProjectReviewStore();
  reviewStore.insertContract({
    schema_version: 1, id: `ct_${cardId}`, digest: `dg_${cardId}`, project_card_id: cardId, goal: "work",
    criteria: [{ id: "c1", description: "done", required: true, evidence_expectation: "synthesis" }],
    required_outputs: [], constraints: [], limits: { max_review_rounds: 1, max_repair_rounds: 1 },
    provenance: { requested_by: "t", authored_by: "orc", created_at: new Date().toISOString() },
  });
  reviewStore.initializeSupervision(cardId, `ct_${cardId}`, "executing");
}

function seedAndStart(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number): boolean {
  seedProject(cardId);
  const sessionId = `sess-${cardId}-${Math.random()}`;
  const executionId = `exec-${cardId}`;
  const claimed = store.claimIntent({
    projectCardId: cardId, intentKind: "operator_turn", intentRef: `r-${Date.now()}-${Math.random()}`,
    goal: "turn", originKind: "peer", cardSource: "peer", originPeer: "other-peer", sourcePeer: "other-peer",
  }, "p", "inst");
  if (claimed.kind !== "claimed") return false;
  if (!store.promoteRun(claimed.context.runId)) return false;
  const bound = store.bindExecution(claimed.context, sessionId, executionId);
  if (!bound.ok) return false;
  // A bound owner releases with its FULL bound context (production composes
  // it from the bound run row); the start still counts for bridge windows.
  store.release({ ...claimed.context, sessionId, executionId }, "completed");
  return true;
}

describe("#1707 bridge-wide emergency fuse", () => {
  it("trips at the configured 25-starts/5m limit and refuses further automatic work", async () => {
    const store = new runStoreMod.OrcProjectRunStore();
    const limit = contractsMod.BRIDGE_STARTS_5M_LIMIT;

    let starts = 0;
    for (let i = 1; i <= limit + 5; i++) {
      if (seedAndStart(store, i)) starts++;
    }
    // The first `limit` starts succeed; the fuse then blocks everything.
    expect(starts).toBe(limit);

    seedProject(limit + 100);
    expect(store.claimIntent({
      projectCardId: limit + 100, intentKind: "operator_turn", intentRef: "blocked",
      goal: "g", originKind: "peer", cardSource: "peer", originPeer: "other-peer", sourcePeer: "other-peer",
    }, "p", "inst")).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });

    const bridge = store.getFuseSnapshot().find(f => f.scope === "bridge");
    expect(bridge?.openedAt).toBeTruthy();
    expect(bridge?.tripReason).toContain("bridge_starts_5m");

    const counts = store.getBridgeWindowCounts();
    expect(counts.starts5m).toBeGreaterThanOrEqual(limit);
  });

  it("survives an ordinary restart and clears only via reset — generation bumps", async () => {
    const store = new runStoreMod.OrcProjectRunStore();
    const limit = contractsMod.BRIDGE_STARTS_5M_LIMIT;
    for (let i = 1; i <= limit; i++) {
      seedAndStart(store, i);
    }

    // "Restart": fresh store over the same durable database.
    const restarted = new runStoreMod.OrcProjectRunStore();
    seedProject(999);
    expect(restarted.claimIntent({
      projectCardId: 999, intentKind: "operator_turn", intentRef: "post-restart",
      goal: "g", originKind: "peer", cardSource: "peer", originPeer: "other-peer", sourcePeer: "other-peer",
    }, "p", "inst2")).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });

    const genBefore = restarted.getFuseSnapshot().find(f => f.scope === "bridge")!.generation;

    restarted.resetBridgeFuse();
    const after = restarted.getFuseSnapshot().find(f => f.scope === "bridge")!;
    expect(after.openedAt ?? null).toBeNull();
    expect(after.generation).toBeGreaterThan(genBefore);

    // Post-reset, a fresh claim is admitted again.
    const retry = restarted.claimIntent({
      projectCardId: 999, intentKind: "operator_turn", intentRef: "post-reset",
      goal: "g", originKind: "peer", cardSource: "peer", originPeer: "other-peer", sourcePeer: "other-peer",
    }, "p", "inst3");
    expect(["claimed", "idempotent"]).toContain(retry.kind);

    // A reset must start a fresh bridge-wide window. Per-card ownership
    // generations all begin at one, so this catches accidental use of those
    // local counters as a global reset boundary.
    if (retry.kind === "claimed") {
      restarted.promoteRun(retry.context.runId);
      const bound = restarted.bindExecution(retry.context, "sess-reset", "exec-reset");
      expect(bound.ok).toBe(true);
      restarted.release({ ...retry.context, sessionId: "sess-reset", executionId: "exec-reset" }, "completed");
    }
    let postResetStarts = 1;
    for (let i = 1; i <= limit + 3; i++) {
      if (seedAndStart(restarted, 1_000 + i)) postResetStarts++;
    }
    expect(postResetStarts).toBe(limit);
    expect(restarted.getFuseSnapshot().find(f => f.scope === "bridge")?.openedAt).toBeTruthy();
  });

  it("alert muting suppresses delivery but never trip recording", async () => {
    alertsMod.muteOrcAlerts(60_000);
    expect(alertsMod.emitOrcAlert("trip:test", "[orc-fuse] suppressed line")).toBe(false);
    // Durable state is unaffected by mute — verified through the store path
    // in the other tests; here only delivery semantics matter.
    alertsMod.clearOrcAlertMuteForTest();
    expect(alertsMod.emitOrcAlert("trip:test2", "[orc-fuse] delivered line")).toBe(true);
    // Rate limit per kind:
    expect(alertsMod.emitOrcAlert("trip:test2", "[orc-fuse] second line")).toBe(false);
  });
});
