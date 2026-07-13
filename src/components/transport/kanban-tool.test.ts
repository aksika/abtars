import { describe, it, expect, vi, beforeEach } from "vitest";

import { kanbanTool } from "./kanban-tool.js";

interface MockBoard {
  createDispatchableCard: ReturnType<typeof vi.fn>;
  kanbanUpdate: ReturnType<typeof vi.fn>;
  kanbanList: ReturnType<typeof vi.fn>;
}

vi.mock("../tasks/kanban-board.js", (): MockBoard => {
  return {
    createDispatchableCard: vi.fn(() => ({ cardId: 42, status: "queued" })),
    kanbanUpdate: vi.fn(),
    kanbanList: vi.fn(() => []),
  };
});

// Get the mock from the module after vi.mock hoists
async function getMockBoard(): Promise<MockBoard> {
  return import("../tasks/kanban-board.js") as Promise<MockBoard>;
}

describe("kanban_manage validation (Layer C — #1327, #955)", () => {
  let board: MockBoard;

  beforeEach(async () => {
    board = await getMockBoard();
    board.createDispatchableCard.mockClear();
    board.createDispatchableCard.mockReturnValue({ cardId: 42, status: "queued" });
  });

  it("rejects type='bug' (ticket category) with a clear error message", async () => {
    const r = await kanbanTool.execute({ action: "create", title: "Stale greeting loop", type: "bug" });
    expect(r).toMatch(/\[err\] invalid card\.type "bug"/);
    expect(board.createDispatchableCard).not.toHaveBeenCalled();
  });

  it("rejects type='feature' (ticket category) — same schema trap, different value", async () => {
    const r = await kanbanTool.execute({ action: "create", title: "x", type: "feature" });
    expect(r).toMatch(/\[err\] invalid card\.type "feature"/);
    expect(board.createDispatchableCard).not.toHaveBeenCalled();
  });

  it("accepts a valid SessionType 'A' (regression guard)", async () => {
    const r = await kanbanTool.execute({ action: "create", title: "real spin work", type: "A" });
    expect(r).toMatch(/^\+ Card #42 created/);
    expect(board.createDispatchableCard).toHaveBeenCalledWith(expect.objectContaining({ type: "A", title: "real spin work" }));
  });

  it("accepts each of the 10 SessionTypes (A|B|C|T|P|S|O|W|D|H)", async () => {
    for (const t of ["A", "B", "C", "T", "P", "S", "O", "W", "D", "H"]) {
      board.createDispatchableCard.mockClear();
      const r = await kanbanTool.execute({ action: "create", title: `work for ${t}`, type: t });
      expect(r, `type ${t} should be accepted`).toMatch(/^\+ Card #42 created/);
      expect(board.createDispatchableCard).toHaveBeenCalledTimes(1);
    }
  });

  it("accepts create without a type field (non-dispatchable tickets)", async () => {
    const r = await kanbanTool.execute({ action: "create", title: "human-readable note" });
    expect(r).toMatch(/^\+ Card #42 created/);
    expect(board.createDispatchableCard).toHaveBeenCalledWith(expect.objectContaining({ type: undefined }));
  });

  it("treats an empty string type the same as omitted (falsy → skip validation)", async () => {
    board.createDispatchableCard.mockReturnValue({ cardId: 42, status: "queued" });
    const r = await kanbanTool.execute({ action: "create", title: "x", type: "" });
    expect(r).toMatch(/^\+ Card #42 created/);
    expect(board.createDispatchableCard).toHaveBeenCalledWith(expect.objectContaining({ type: "" }));
  });
});
