/**
 * #1276 — handleEffort: /effort (primary) + /thinking (alias) with pi-ai's level
 * set (off|low|medium|high|xhigh).
 *
 * With PiCoreTransport, reasoning effort is configured through the Pi model
 * (StreamFn options), not via a ConversationSession. The command acknowledges
 * the setting; the host translates it into the StreamFn reasoning options.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./registry.js", () => ({ triggerResetSession: vi.fn() }));

const { handleEffort } = await import("./handlers-transport.js");
import type { CommandContext } from "./types.js";

function makeCtx(): { ctx: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(1);
  const ctx = {
    sessionKey: "1_A_01", chatId: 1, userId: "u", platform: "telegram",
    reply,
    transport: {} as unknown as CommandContext["transport"],
  } as unknown as CommandContext;
  return { ctx, reply };
}

describe("handleEffort — Pi transport", () => {
  describe("effort levels", () => {
    for (const level of ["off", "low", "medium", "high", "xhigh"] as const) {
      it(`/effort ${level} acknowledges the setting`, async () => {
        const { ctx, reply } = makeCtx();
        const out = await handleEffort(`/effort ${level}`, ctx);
        expect(out).toBe(true);
        expect(reply).toHaveBeenCalledWith(`Reasoning effort: ${level} (Pi transport)`);
      });
    }
  });

  describe("alias", () => {
    it("/thinking routes to the same handler", async () => {
      const { ctx, reply } = makeCtx();
      await handleEffort("/thinking medium", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning effort: medium (Pi transport)");
    });
  });

  describe("display toggle", () => {
    it("/effort show acknowledges", async () => {
      const { ctx, reply } = makeCtx();
      await handleEffort("/effort show", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning display: on (Pi transport)");
    });

    it("/effort hide acknowledges", async () => {
      const { ctx, reply } = makeCtx();
      await handleEffort("/effort hide", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning display: off (Pi transport)");
    });
  });

  describe("bare /effort", () => {
    it("shows options message", async () => {
      const { ctx, reply } = makeCtx();
      await handleEffort("/effort", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning effort via Pi model config. Options: off, low, medium, high, xhigh.");
    });
  });

  describe("unknown arg", () => {
    it("/effort banana shows options", async () => {
      const { ctx, reply } = makeCtx();
      await handleEffort("/effort banana", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning effort via Pi model config. Options: off, low, medium, high, xhigh.");
    });
  });
});
