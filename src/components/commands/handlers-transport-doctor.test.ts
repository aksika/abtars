/**
 * handlers-transport-doctor.test.ts — #1940 leftover: /model doctor is
 * retired. It must never probe endpoints nor write models.json; Pi owns
 * retry and availability.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./registry.js", () => ({ triggerResetSession: vi.fn() }));

const { handleModels } = await import("./handlers-transport.js");
import type { CommandContext } from "./types.js";

function makeCtx(): { ctx: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(1);
  const ctx = {
    sessionKey: "1_A_01",
    chatId: 1,
    userId: "u",
    platform: "telegram",
    reply,
    transport: {},
    sessionManager: { getSessionById: vi.fn().mockReturnValue(undefined) },
  } as unknown as CommandContext;
  return { ctx, reply };
}

describe("handleModels /model doctor retirement (#1940)", () => {
  it("replies retired without probing or writing the catalog", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { ctx, reply } = makeCtx();
    const out = await handleModels("/model doctor", ctx);
    expect(out).toBe(true);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("retired"),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
