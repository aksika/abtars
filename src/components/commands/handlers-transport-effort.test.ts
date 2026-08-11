/**
 * #1619 — handleEffort: /effort (primary) + /thinking (alias) mutates the
 * ATTACHED session transport's session-scoped reasoning level and reports the
 * requested/effective pair. `off` is a real reasoning level, never a display
 * toggle; show/hide were removed. Transports without runtime effort support
 * return an explicit unsupported response.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./registry.js", () => ({ triggerResetSession: vi.fn() }));

const { handleEffort } = await import("./handlers-transport.js");
import type { CommandContext } from "./types.js";
import type { IKiroTransport, ReasoningEffortState } from "../transport/kiro-transport.js";

function makeSetEffortTransport(impl: (level: string) => ReasoningEffortState) {
  return {
    setReasoningEffort: vi.fn(impl as never),
    getRuntimeStatus: vi.fn(() => ({})),
  };
}

function makeCtx(overrides: {
  attached?: Partial<IKiroTransport> & { setReasoningEffort?: unknown };
  global?: Partial<IKiroTransport>;
  sessionManager?: { getSessionById: () => unknown };
}): { ctx: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(1);
  const attached = { getRuntimeStatus: vi.fn(() => ({})), ...overrides.attached };
  const ctx = {
    sessionKey: "1_A_01", chatId: 1, userId: "u", platform: "telegram",
    reply,
    transport: { ...overrides.global } as unknown as CommandContext["transport"],
    sessionManager: {
      getSessionById: overrides.sessionManager
        ? overrides.sessionManager.getSessionById
        : () => ({ transport: attached }),
    },
  } as unknown as CommandContext;
  return { ctx, reply };
}

describe("handleEffort — attached Pi transport", () => {
  describe("effort levels", () => {
    for (const level of ["off", "low", "medium", "high", "xhigh"] as const) {
      it(`/effort ${level} mutates the ATTACHED transport and reports it`, async () => {
        const attached = makeSetEffortTransport((l) => ({ requested: l as never, effective: l as never }));
        const globalTransport = makeSetEffortTransport(() => ({ requested: "low" as never, effective: "low" as never }));
        const { ctx, reply } = makeCtx({ attached, global: globalTransport });
        const out = await handleEffort(`/effort ${level}`, ctx);
        expect(out).toBe(true);
        expect(attached.setReasoningEffort).toHaveBeenCalledWith(level);
        // The bridge-global transport is never mutated.
        expect(globalTransport.setReasoningEffort).not.toHaveBeenCalled();
        expect(reply).toHaveBeenCalledWith(`Reasoning effort: ${level}`);
      });
    }
  });

  describe("clamping", () => {
    it("reports requested and effective when Pi clamps", async () => {
      const attached = makeSetEffortTransport((l) => ({ requested: l as never, effective: "high" as never }));
      const { ctx, reply } = makeCtx({ attached });
      await handleEffort("/effort xhigh", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning effort: xhigh (effective: high)");
    });
  });

  describe("alias", () => {
    it("/thinking routes to the same handler with identical semantics", async () => {
      const attached = makeSetEffortTransport((l) => ({ requested: l as never, effective: l as never }));
      const { ctx, reply } = makeCtx({ attached });
      await handleEffort("/thinking medium", ctx);
      expect(attached.setReasoningEffort).toHaveBeenCalledWith("medium");
      expect(reply).toHaveBeenCalledWith("Reasoning effort: medium");
    });
  });

  describe("unsupported transport", () => {
    it("returns an explicit unsupported response, never pretending", async () => {
      const { ctx, reply } = makeCtx({ attached: { getRuntimeStatus: vi.fn(() => ({})) } });
      await handleEffort("/effort high", ctx);
      expect(reply).toHaveBeenCalledWith("Runtime reasoning effort is not supported by this transport.");
    });
  });

  describe("bare /effort", () => {
    it("reports the live effective level from the attached transport", async () => {
      const attached = {
        getRuntimeStatus: vi.fn(() => ({ reasoning: "high" as const })),
      };
      const { ctx, reply } = makeCtx({ attached });
      await handleEffort("/effort", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning effort: high");
    });

    it("reports requested/effective distinction when clamping differs", async () => {
      const attached = {
        getRuntimeStatus: vi.fn(() => ({ reasoning: "high" as const, reasoningRequested: "xhigh" as const })),
      };
      const { ctx, reply } = makeCtx({ attached });
      await handleEffort("/effort", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning effort: xhigh (effective: high)");
    });

    it("falls back to the bridge-global transport when the session has none", async () => {
      const globalTransport = {
        setReasoningEffort: vi.fn((l: string) => ({ requested: l, effective: l })),
        getRuntimeStatus: vi.fn(() => ({ reasoning: "off" as const })),
      };
      const { ctx, reply } = makeCtx({ sessionManager: { getSessionById: () => undefined }, global: globalTransport });
      await handleEffort("/effort", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning effort: off");
    });
  });

  describe("rejected vocabulary", () => {
    it("/effort show is rejected with the level vocabulary", async () => {
      const attached = makeSetEffortTransport((l) => ({ requested: l as never, effective: l as never }));
      const { ctx, reply } = makeCtx({ attached });
      await handleEffort("/effort show", ctx);
      expect(attached.setReasoningEffort).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith("Usage: /effort off|low|medium|high|xhigh");
    });

    it("/effort hide is rejected with the level vocabulary", async () => {
      const attached = makeSetEffortTransport((l) => ({ requested: l as never, effective: l as never }));
      const { ctx, reply } = makeCtx({ attached });
      await handleEffort("/effort hide", ctx);
      expect(attached.setReasoningEffort).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith("Usage: /effort off|low|medium|high|xhigh");
    });

    it("/effort banana shows the level vocabulary", async () => {
      const attached = makeSetEffortTransport((l) => ({ requested: l as never, effective: l as never }));
      const { ctx, reply } = makeCtx({ attached });
      await handleEffort("/effort banana", ctx);
      expect(attached.setReasoningEffort).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith("Usage: /effort off|low|medium|high|xhigh");
    });
  });
});
