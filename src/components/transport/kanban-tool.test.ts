/**
 * kanban-tool.test.ts — Tests for kanban_manage write-time validation (#1327).
 *
 * The create action validates card.type against SESSION_PROFILES: a ticket
 * category like "bug" or "feature" used to be silently accepted (and
 * later crash the bridge via spin.ts:346 when drainQueued tried to dispatch
 * the card). The fix rejects the write at the source with a clear error
 * pointing the agent at the schema confusion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tasks/kanban-board.js", () => ({
  kanbanEnqueue: vi.fn(() => 42),
  kanbanUpdate: vi.fn(),
  kanbanList: vi.fn(() => []),
}));

import { kanbanEnqueue } from "../tasks/kanban-board.js";
import { kanbanTool } from "./kanban-tool.js";

describe("kanban_manage validation (Layer C — #1327)", () => {
  beforeEach(() => {
    vi.mocked(kanbanEnqueue).mockClear();
    vi.mocked(kanbanEnqueue).mockReturnValue(42);
  });

  it("rejects type='bug' (ticket category) with a clear error message", async () => {
    const r = await kanbanTool.execute({ action: "create", title: "Stale greeting loop", type: "bug" });
    expect(r).toMatch(/\[err\] invalid card\.type "bug"/);
    expect(r).toMatch(/must be a SessionType/);
    expect(r).toMatch(/A\/B\/C\/T\/P\/S\/O\/W\/D\/H/);
    expect(kanbanEnqueue).not.toHaveBeenCalled();
  });

  it("rejects type='feature' (ticket category) — same schema trap, different value", async () => {
    const r = await kanbanTool.execute({ action: "create", title: "x", type: "feature" });
    expect(r).toMatch(/\[err\] invalid card\.type "feature"/);
    expect(kanbanEnqueue).not.toHaveBeenCalled();
  });

  it("accepts a valid SessionType 'A' (regression guard for the validator being too eager)", async () => {
    const r = await kanbanTool.execute({ action: "create", title: "real spin work", type: "A" });
    expect(r).toMatch(/^\+ Card #42 created/);
    expect(kanbanEnqueue).toHaveBeenCalledWith("real spin work", "agent", undefined, expect.objectContaining({ type: "A" }));
  });

  it("accepts each of the 10 SessionTypes (A|B|C|T|P|S|O|W|D|H)", async () => {
    for (const t of ["A", "B", "C", "T", "P", "S", "O", "W", "D", "H"]) {
      vi.mocked(kanbanEnqueue).mockClear();
      const r = await kanbanTool.execute({ action: "create", title: `work for ${t}`, type: t });
      expect(r, `type ${t} should be accepted`).toMatch(/^\+ Card #42 created/);
      expect(kanbanEnqueue).toHaveBeenCalledTimes(1);
    }
  });

  it("accepts create without a type field (non-dispatchable tickets — omit, don't try to dispatch)", async () => {
    const r = await kanbanTool.execute({ action: "create", title: "human-readable note" });
    expect(r).toMatch(/^\+ Card #42 created/);
    expect(kanbanEnqueue).toHaveBeenCalledWith("human-readable note", "agent", undefined, expect.objectContaining({ type: undefined }));
  });

  it("treats an empty string type the same as omitted (falsy → skip validation)", async () => {
    // Policy decision: type="" is treated as "not set" (falsy) and skips
    // validation, ending up as type="" in kanban (not normalized to undefined
    // at this layer — the schema-strip happens in kanbanEnqueue). The
    // important contract for #1327 is that empty string does NOT trigger
    // the "invalid type" error path. If a stricter "rejected empty" is
    // wanted, change the validator to
    // `args.type !== undefined && !isValidSessionType(args.type)`.
    const r = await kanbanTool.execute({ action: "create", title: "x", type: "" });
    expect(r).toMatch(/^\+ Card #42 created/);
    // type="" passes through to kanbanEnqueue (the validator was skipped
    // because of the falsy short-circuit).
    expect(kanbanEnqueue).toHaveBeenCalled();
    const call = vi.mocked(kanbanEnqueue).mock.calls[0]!;
    expect(call[0]).toBe("x");
    expect((call[3] as { type?: string }).type).toBe("");
  });
});
