/**
 * kanban-delivery.test.ts — unit tests for deliverCard (#1298).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let board: typeof import("./kanban-board.js");
let deliverCard: typeof import("./kanban-delivery.js").deliverCard;
let ProjectReviewStore: typeof import("../project-acceptance/project-review-store.js").ProjectReviewStore;
let logWarnMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `delivery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  logWarnMock = vi.fn();
  vi.doMock("../logger.js", () => ({ logInfo: vi.fn(), logWarn: logWarnMock, logError: vi.fn(), logDebug: vi.fn(), logTrace: vi.fn(), redactSecrets: (s: string) => s }));
  board = await import("./kanban-board.js");
  ({ deliverCard } = await import("./kanban-delivery.js"));
  const reviewMod = await import("../project-acceptance/project-review-store.js");
  ProjectReviewStore = reviewMod.ProjectReviewStore;
});

afterEach(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });

function makeDeps() {
  return {
    sendMessage: vi.fn().mockResolvedValue("sent" as const),
    sendDocument: vi.fn().mockResolvedValue("sent" as const),
    announce: vi.fn().mockResolvedValue(undefined),
    chatIdFor: vi.fn().mockReturnValue("100"),
  };
}

function makeCard(overrides: Partial<import("./kanban-board.js").KanbanCard> = {}): import("./kanban-board.js").KanbanCard {
  const id = board.kanbanEnqueue("Test task", "cron");
  board.kanbanRunning(id);
  board.kanbanComplete(id, null, "ok");
  return { ...board.kanbanGetCard(id)!, ...overrides };
}

describe("deliverCard — deliver mode", () => {
  it("defers a card until the scheduled owner releases delivery", async () => {
    const id = board.kanbanEnqueue("Deferred task", "task", "run-1", { deliveryReady: false });
    board.kanbanRunning(id);
    board.kanbanComplete(id, null, "validated");
    const deps = makeDeps();

    await deliverCard(board.kanbanGetCard(id)!, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(id)!.status).toBe("done");

    board.kanbanSetDeliveryReady(id);
    await deliverCard(board.kanbanGetCard(id)!, deps);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(board.kanbanGetCard(id)!.status).toBe("delivered");
  });

  it("sends plain confirmation via sendMessage, never touches announce/model", async () => {
    const card = makeCard({ delivery_mode: "deliver" });
    const deps = makeDeps();
    await deliverCard(card, deps);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.sendMessage.mock.calls[0]![1]).toContain("Test task");
    expect(deps.sendMessage.mock.calls[0]![1]).toContain("ok");
    expect(deps.announce).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });

  it("sends only the document (no confirmation text, no host path) when result_path is set", async () => {
    const card = makeCard({ delivery_mode: "deliver", result_path: "/tmp/report.md" });
    const deps = makeDeps();
    await deliverCard(card, deps);
    expect(deps.sendDocument).toHaveBeenCalledOnce();
    expect(deps.sendDocument.mock.calls[0]![1]).toBe("/tmp/report.md");
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });

  it("marks card as delivered", async () => {
    const card = makeCard({ delivery_mode: "deliver" });
    await deliverCard(card, makeDeps());
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });
});

describe("deliverCard — announce mode", () => {
  it("sends direct message with result_summary, does NOT call announce model", async () => {
    const card = makeCard({ delivery_mode: "announce", result_summary: "analysis complete" });
    const deps = makeDeps();
    await deliverCard(card, deps);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.sendMessage.mock.calls[0]![1]).toContain("Test task");
    expect(deps.sendMessage.mock.calls[0]![1]).toContain("analysis complete");
    expect(deps.announce).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });
});

describe("deliverCard — silent mode", () => {
  it("marks delivered without sending anything", async () => {
    const card = makeCard({ delivery_mode: "silent" });
    const deps = makeDeps();
    await deliverCard(card, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });
});

describe("#1520 delivery separation", () => {
  it("definitely_not_sent returns the card to the bounded poll for a delivery-only retry", async () => {
    const card = makeCard();
    const deps = makeDeps();
    deps.sendMessage.mockResolvedValue("not_sent" as const);
    await deliverCard(card, deps);
    expect(board.kanbanGetCard(card.id)!.delivery_result).toBe("definitely_not_sent");
    expect(board.kanbanGetCard(card.id)!.status).toBe("done");
    // A second poll retries delivery only — never re-executes anything.
    deps.sendMessage.mockResolvedValue("sent" as const);
    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });

  it("unknown send state blocks automatic resend and is visible for operator review", async () => {
    const card = makeCard();
    const deps = makeDeps();
    deps.sendMessage.mockResolvedValue("unknown" as const);
    await deliverCard(card, deps);
    expect(board.kanbanGetCard(card.id)!.delivery_result).toBe("unknown");
    // Repeated polls never resend a card in unknown state.
    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("delivery failure never appends task history or reruns execution", async () => {
    const card = makeCard();
    const deps = makeDeps();
    deps.sendMessage.mockResolvedValue("not_sent" as const);
    const { deliverCard: dc } = await import("./kanban-delivery.js");
    await dc(card, deps);
    const { recentRuns } = await import("./task-history-store.js");
    expect(recentRuns(card.source_id ?? "none", 5)).toHaveLength(0);
  });

  it("repeated delivery polls cannot duplicate a delivered card", async () => {
    const card = makeCard();
    const deps = makeDeps();
    await deliverCard(card, deps);
    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });
});

describe("deliverCard — #1724 Main-owned scheduled T announcements", () => {
  function makeScheduledTCard(resultSummary = "Good morning aksika!"): import("./kanban-board.js").KanbanCard {
    const id = board.kanbanEnqueue("Morning greeting", "task", "run-t-1", {
      type: "T",
      deliveryMode: "announce",
      chatId: "100",
      deliveryReady: false,
    });
    board.kanbanRunning(id);
    board.kanbanComplete(id, null, resultSummary);
    board.kanbanSetDeliveryReady(id);
    return board.kanbanGetCard(id)!;
  }

  function makeKAnnounceCard(): import("./kanban-board.js").KanbanCard {
    const id = board.kanbanEnqueue("Spanish tutor kickoff", "task", "run-k-1", {
      type: "K",
      deliveryMode: "announce",
      chatId: "100",
    });
    board.kanbanRunning(id);
    board.kanbanComplete(id, null, "Hola! Ready?");
    return board.kanbanGetCard(id)!;
  }

  it("routes a matching scheduled T announce through Main and never calls the raw sender", async () => {
    const card = makeScheduledTCard();
    const deps = makeDeps();
    const announceToMain = vi.fn().mockResolvedValue("sent" as const);
    (deps as Record<string, unknown>).announceToMain = announceToMain;

    await deliverCard(card, deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(announceToMain).toHaveBeenCalledTimes(1);
    expect(announceToMain.mock.calls[0]![0].id).toBe(card.id);
    expect(announceToMain.mock.calls[0]![0].result_summary).toBe("Good morning aksika!");
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
    expect(board.kanbanGetCard(card.id)!.delivery_result).toBe("sent");
  });

  it("intercepts a matching card even when a result_path exists — Main is the only route", async () => {
    const id = board.kanbanEnqueue("Morning greeting", "task", "run-t-2", { type: "T", deliveryMode: "announce", chatId: "100" });
    board.kanbanRunning(id);
    board.kanbanComplete(id, join(TEST_HOME, "stray.md"), "hello");
    const deps = makeDeps();
    const announceToMain = vi.fn().mockResolvedValue("sent" as const);
    (deps as Record<string, unknown>).announceToMain = announceToMain;

    await deliverCard(board.kanbanGetCard(id)!, deps);

    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(announceToMain).toHaveBeenCalledOnce();
    expect(board.kanbanGetCard(id)!.status).toBe("delivered");
  });

  it("maps not_sent to definitely_not_sent and permits exactly one rerun that succeeds", async () => {
    const card = makeScheduledTCard();
    const deps = makeDeps();
    const announceToMain = vi.fn().mockResolvedValueOnce("not_sent" as const).mockResolvedValueOnce("sent" as const);
    (deps as Record<string, unknown>).announceToMain = announceToMain;

    await deliverCard(card, deps);
    expect(board.kanbanGetCard(card.id)!.delivery_result).toBe("definitely_not_sent");
    expect(board.kanbanGetCard(card.id)!.status).toBe("done");

    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    expect(announceToMain).toHaveBeenCalledTimes(2);
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");

    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    expect(announceToMain).toHaveBeenCalledTimes(2);
  });

  it("maps unknown to operator-review semantics with no automatic resend", async () => {
    const card = makeScheduledTCard();
    const deps = makeDeps();
    const announceToMain = vi.fn().mockResolvedValue("unknown" as const);
    (deps as Record<string, unknown>).announceToMain = announceToMain;

    await deliverCard(card, deps);
    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    await deliverCard(board.kanbanGetCard(card.id)!, deps);
    expect(announceToMain).toHaveBeenCalledTimes(1);
    expect(board.kanbanGetCard(card.id)!.delivery_result).toBe("unknown");
  });

  it("treats an unwired Main ingress as definitely-not-sent — no direct fallback send", async () => {
    const card = makeScheduledTCard();
    const deps = makeDeps();

    await deliverCard(card, deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(card.id)!.delivery_result).toBe("definitely_not_sent");
  });

  it("keeps a scheduled K role card on its direct delivery route", async () => {
    const card = makeKAnnounceCard();
    const deps = makeDeps();
    const announceToMain = vi.fn().mockResolvedValue("sent" as const);
    (deps as Record<string, unknown>).announceToMain = announceToMain;

    await deliverCard(card, deps);

    expect(announceToMain).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.sendMessage.mock.calls[0]![1]).toContain("Hola! Ready?");
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });

  it("keeps a non-task announce card on its direct delivery route", async () => {
    const card = makeCard({ delivery_mode: "announce", result_summary: "analysis complete" });
    const deps = makeDeps();
    const announceToMain = vi.fn().mockResolvedValue("sent" as const);
    (deps as Record<string, unknown>).announceToMain = announceToMain;

    await deliverCard(card, deps);

    expect(announceToMain).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });

  it("maps an ingress rejection to unknown when the callback throws", async () => {
    const card = makeScheduledTCard();
    const deps = makeDeps();
    const announceToMain = vi.fn().mockRejectedValue(new Error("pipeline exploded"));
    (deps as Record<string, unknown>).announceToMain = announceToMain;

    await deliverCard(card, deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(card.id)!.delivery_result).toBe("unknown");
    expect(board.kanbanGetCard(card.id)!.status).toBe("done");
  });
});

describe("deliverCard — O-type acceptance gate (#1595)", () => {
  function makeOCard(initialState: string): { id: number; card: import("./kanban-board.js").KanbanCard } {
    // Non-scheduled project root: the acceptance gate is the behavior under
    // test — a task-sourced root would additionally require a terminal
    // successful task_runs row (covered by the #1644 claim tests).
    const id = board.kanbanEnqueue("Daily Project", "test", undefined, { type: "O" });
    board.kanbanRunning(id);
    board.kanbanComplete(id, join(TEST_HOME, "report.md"), "Report ready");
    new ProjectReviewStore().initializeSupervision(id, `pc_${id}`, initialState as "executing" | "accepted");
    return { id, card: board.kanbanGetCard(id)! };
  }

  it("does not send an unaccepted O card and leaves it done", async () => {
    const { id, card } = makeOCard("executing");
    const deps = makeDeps();
    await deliverCard(card, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(id)!.status).toBe("done");
    expect(board.kanbanGetCard(id)!.delivery_attempts).toBe(0);
  });

  it("warns once per card episode, not once per delivery poll", async () => {
    const { id, card } = makeOCard("executing");
    const deps = makeDeps();
    // Three consecutive polls (heartbeat cadence) — one warning total.
    await deliverCard(board.kanbanGetCard(id)!, deps);
    await deliverCard(board.kanbanGetCard(id)!, deps);
    await deliverCard(board.kanbanGetCard(id)!, deps);
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock.mock.calls[0]![1]).toContain("no accepted supervision");
    // Acceptance later unblocks delivery normally.
    new ProjectReviewStore().setState(id, "accepted");
    await deliverCard(board.kanbanGetCard(id)!, deps);
    expect(deps.sendDocument).toHaveBeenCalledTimes(1);
    expect(board.kanbanGetCard(id)!.status).toBe("delivered");
  });

  it("delivers an accepted O card normally", async () => {
    const { id, card } = makeOCard("accepted");
    const deps = makeDeps();
    await deliverCard(card, deps);
    expect(deps.sendDocument).toHaveBeenCalledTimes(1);
    expect(deps.sendDocument).toHaveBeenCalledWith("100", join(TEST_HOME, "report.md"), "Daily Project");
    expect(board.kanbanGetCard(id)!.status).toBe("delivered");
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});

describe("deliverCard — #1644 scheduled project delivery claim", () => {
  function makeScheduledOCard(runId: string): number {
    const id = board.kanbanEnqueue("Daily Project", "task", runId, { type: "O" });
    board.kanbanRunning(id);
    board.kanbanComplete(id, join(TEST_HOME, "report.md"), "Report ready");
    const review = new ProjectReviewStore();
    review.initializeSupervision(id, `pc_${id}`, "accepted");
    return id;
  }

  function insertRun(runId: string, finished: boolean, outcome: string | null): void {
    const db = board.requireTaskDatabase();
    db.prepare(`
      INSERT INTO task_runs (run_id, task_id, group_id, attempt, trigger, occurrence_at, reserved_at, deadline_at, phase, last_progress_at, owner_pid, finished_at, outcome)
      VALUES (?, 't', 'g', 1, 'schedule', 0, 0, 0, 'settling', 0, 1, ?, ?)
    `).run(runId, finished ? Date.now() : null, outcome);
  }

  it("loses the claim for a failed run — the blocked root's report is never sent", async () => {
    const id = makeScheduledOCard("run-failed");
    insertRun("run-failed", true, "failed");
    const deps = makeDeps();
    await deliverCard(board.kanbanGetCard(id)!, deps);
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const card = board.kanbanGetCard(id)!;
    expect(card.status).toBe("done");
    expect(card.delivery_attempts).toBe(0);
  });

  it("loses the claim while the run is still live — no early delivery", async () => {
    const id = makeScheduledOCard("run-live");
    insertRun("run-live", false, null);
    const deps = makeDeps();
    await deliverCard(board.kanbanGetCard(id)!, deps);
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(id)!.delivery_attempts).toBe(0);
  });

  it("claims and sends exactly once for an accepted project with a successful run", async () => {
    const id = makeScheduledOCard("run-ok");
    insertRun("run-ok", true, "success");
    const deps = makeDeps();
    await deliverCard(board.kanbanGetCard(id)!, deps);
    await deliverCard(board.kanbanGetCard(id)!, deps);
    expect(deps.sendDocument).toHaveBeenCalledTimes(1);
    expect(board.kanbanGetCard(id)!.status).toBe("delivered");
    expect(board.kanbanGetCard(id)!.delivery_attempts).toBe(1);
  });
});
