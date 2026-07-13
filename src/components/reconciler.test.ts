/**
 * reconciler.test.ts — #1411 retry ownership domain guard.
 *
 * Verifies that:
 *  - Unsupervised legacy cards are completely invisible to Reconciler.
 *  - Supervised cards still dispatch through the normal path.
 *  - Fail-closed behavior when supervision state is missing or errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const dispatchMock = vi.fn();
vi.mock("./spin.js", () => ({
  spin: { dispatch: dispatchMock },
}));

const kanbanGetCardMock = vi.fn();
const kanbanGetChildrenMock = vi.fn();
const isUnblockedMock = vi.fn().mockReturnValue(true);
const kanbanUpdateMock = vi.fn();
const cascadeFailMock = vi.fn();
vi.mock("./tasks/kanban-board.js", () => ({
  kanbanFail: vi.fn(),
  kanbanComplete: vi.fn(),
  kanbanUpdate: kanbanUpdateMock,
  kanbanGetCard: kanbanGetCardMock,
  kanbanGetChildren: kanbanGetChildrenMock,
  isUnblocked: isUnblockedMock,
  cascadeFail: cascadeFailMock,
}));

const cardHasContractMock = vi.fn();
const getContractForCardMock = vi.fn();
vi.mock("./worker-supervision-service.js", () => {
  return {
    WorkerSupervisionService: class {
      cardHasContract = cardHasContractMock;
      getContractForCard = getContractForCardMock;
    },
  };
});

const getLatestAttemptMock = vi.fn().mockReturnValue(null);
vi.mock("./worker-supervision-store.js", () => {
  return {
    WorkerSupervisionStore: class {
      getLatestAttempt = getLatestAttemptMock;
    },
  };
});

// These are imported by reconcileProject / evaluateLease — mock as no-ops
vi.mock("./executor-lease-store.js", () => ({
  ExecutorLeaseStore: vi.fn().mockImplementation(() => ({
    getSnapshot: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock("./project-acceptance/project-review-store.js", () => ({
  ProjectReviewStore: vi.fn().mockImplementation(() => ({
    contractExists: vi.fn().mockReturnValue(false),
  })),
}));

// Catch-all for retry-service dynamic require — return error
vi.mock("./retry/retry-service.js", () => ({
  RetryService: vi.fn().mockImplementation(() => ({
    handleTerminalAttempt: vi.fn().mockReturnValue({ error: "mock error" }),
  })),
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

let mod: typeof import("./reconciler.js");

beforeEach(async () => {
  vi.clearAllMocks();
  isUnblockedMock.mockReturnValue(true);
  getLatestAttemptMock.mockReturnValue(null);
  cardHasContractMock.mockReturnValue(false);
  mod = await import("./reconciler.js");
});

function makeCard(overrides: Partial<{
  id: number; status: string; type: string; title: string; notes: string | null;
  parent_id: number | null; delivery_attempts: number;
}> = {}): NonNullable<ReturnType<typeof kanbanGetCardMock>> {
  return {
    id: 1, status: "queued", type: "W", title: "test card", notes: null,
    parent_id: null, delivery_attempts: 0, source: "agent",
    source_id: null, assignee: "local", priority: "MEDIUM",
    goal: null, result_summary: null, result_path: null,
    error: null, approval: null, due_at: null, labels: null,
    blocked_by: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), completed_at: null,
    delivered_at: null, max_tokens: null, tokens_used: null,
    delivery_mode: "deliver", chat_id: null, source_peer: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Reconciler — #1411 domain guard", () => {
  describe("unsupervised cards (no contract)", () => {
    it("queued card produces zero dispatches", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("failed card produces zero dispatches", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "failed" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("running card produces zero dispatches", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "running" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("fifty wakeups for one unsupervised card yield zero dispatches", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "failed" }));
      for (let i = 0; i < 50; i++) {
        mod.requestReconcile(1);
      }
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("unsupervised B card is never dispatched as W", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued", type: "B" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });

  describe("supervised cards (has contract)", () => {
    it("queued card with pending attempt dispatches once", async () => {
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending" });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: 1, type: "W" }),
      );
    });

    it("dispatches exactly once under duplicate wakeups", async () => {
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending" });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      for (let i = 0; i < 10; i++) {
        mod.requestReconcile(1);
      }
      await flush();
      // The keyed scheduler coalesces: first call sets dirty=false, subsequent
      // calls set dirty=true but do not dispatch again until next reconcile pass
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });

    it("queued card with no pending attempt does not dispatch (fail closed)", async () => {
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue(null);
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("queued card with non-pending lifecycle does not dispatch", async () => {
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "running" });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("two supervised card IDs can each make progress", async () => {
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending" });

      kanbanGetCardMock.mockImplementation((id: number) => {
        if (id === 1) return makeCard({ id: 1, status: "queued" });
        if (id === 2) return makeCard({ id: 2, status: "queued" });
        return null;
      });

      mod.requestReconcile(1);
      mod.requestReconcile(2);
      await flush();
      expect(dispatchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("supervised card classification/directive errors", () => {
    it("classification error leaves card failed with zero dispatches", async () => {
      // Mock RetryService to return error from handleTerminalAttempt
      // The catch-all mock already does this — but we need to clear
      // and set the module mock per test
      vi.resetModules();
      vi.doMock("./retry/retry-service.js", () => ({
        RetryService: vi.fn().mockImplementation(() => ({
          handleTerminalAttempt: vi.fn().mockReturnValue({ error: "classification failed (mock)" }),
        })),
      }));
      // Re-mock everything else
      const { WorkerSupervisionService: WSS } = await import("./worker-supervision-service.js");
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "failed" });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "failed" }));

      const localMod = await import("./reconciler.js");
      localMod.requestReconcile(1);
      await flush();

      expect(dispatchMock).not.toHaveBeenCalled();
      expect(kanbanUpdateMock).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("non-existent card is silently ignored", async () => {
      kanbanGetCardMock.mockReturnValue(null);
      mod.requestReconcile(999);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("Pi card still routes through Pi lane regardless of contract", async () => {
      // Pi lane runs first — should not be blocked by domain guard
      cardHasContractMock.mockReturnValue(false);
      getLatestAttemptMock.mockReturnValue(null);
      // Pi card has no executor lease or Pi service set, so it will just warn and return
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued", type: "pi" }));
      mod.requestReconcile(1);
      await flush();
      // No dispatch since Pi service is null, but importantly no crash
      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });
});
