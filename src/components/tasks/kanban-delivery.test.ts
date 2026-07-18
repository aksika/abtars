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

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `delivery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  vi.doMock("../logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }));
  board = await import("./kanban-board.js");
  ({ deliverCard } = await import("./kanban-delivery.js"));
});

afterEach(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });

function makeDeps() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
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
