/**
 * #1276 — handleEffort: /effort (primary) + /thinking (alias) with pi-ai's level
 * set (off|low|medium|high|xhigh). /reasoning is removed (no back-compat).
 *
 * Test surface:
 *  - level set: each of off|low|medium|high|xhigh sets session.reasoningEffort
 *  - display toggle: show/hide flip session.showReasoning only
 *  - alias: /thinking sets the same as /effort
 *  - the `off` collision: /effort off sets EFFORT, NOT display
 *  - ACP guard: getActiveSession undefined → "not supported on this transport"
 *  - no active session on a transport that has the method → "No active session."
 *  - bare /effort echoes current state
 *  - unknown arg falls through to the status echo (no error)
 */
import { describe, it, expect, vi } from "vitest";

// handlers-transport.ts imports triggerResetSession from ./registry.js, which
// cycles through message-pipeline → pipeline/commands → commands/index →
// handlers (re-exports handlers-transport). Stub the registry import to break
// the cycle — handleEffort doesn't use anything from the registry.
vi.mock("./registry.js", () => ({ triggerResetSession: vi.fn() }));

const { handleEffort } = await import("./handlers-transport.js");
import type { CommandContext } from "./types.js";

type Session = {
  showReasoning: boolean;
  reasoningEffort: "off" | "low" | "medium" | "high" | "xhigh" | null;
};

function makeSession(): Session {
  return { showReasoning: false, reasoningEffort: null };
}

function makeCtx(opts: { transport?: { getActiveSession?: () => Session | null; getActiveSessionIsOptional?: boolean } | null; session?: Session | null } = {}): { ctx: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const session = opts.session === undefined ? makeSession() : opts.session;
  // The transport is typed as the full IKiroTransport; for these tests we
  // only need getActiveSession. We make the method optional to cover both
  // the ACP case (method absent) and the DirectApi case (method present).
  const transport = opts.transport === null
    ? null
    : (opts.transport ?? { getActiveSession: () => session });
  const reply = vi.fn().mockResolvedValue(1);
  const ctx = {
    sessionKey: "1_A_01", chatId: 1, userId: "u", platform: "telegram",
    reply,
    transport: transport as unknown as CommandContext["transport"],
  } as unknown as CommandContext;
  return { ctx, reply };
}

describe("handleEffort (#1276) — /effort + /thinking alias", () => {
  describe("effort levels — pi-ai verbatim (off|low|medium|high|xhigh)", () => {
    for (const level of ["off", "low", "medium", "high", "xhigh"] as const) {
      it(`/effort ${level} sets session.reasoningEffort = "${level}"`, async () => {
        const { ctx, reply } = makeCtx();
        const out = await handleEffort(`/effort ${level}`, ctx);
        expect(out).toBe(true);
        const sess = (ctx.transport as unknown as { getActiveSession: () => Session }).getActiveSession()!;
        expect(sess.reasoningEffort).toBe(level);
        expect(reply).toHaveBeenCalledWith(`Reasoning effort: ${level}`);
      });
    }
  });

  describe("alias — /thinking routes to the same handler", () => {
    it("/thinking medium sets the same as /effort medium", async () => {
      const { ctx: ctx1, reply: r1 } = makeCtx();
      const { ctx: ctx2, reply: r2 } = makeCtx();
      await handleEffort("/effort medium", ctx1);
      await handleEffort("/thinking medium", ctx2);
      const s1 = (ctx1.transport as unknown as { getActiveSession: () => Session }).getActiveSession()!;
      const s2 = (ctx2.transport as unknown as { getActiveSession: () => Session }).getActiveSession()!;
      expect(s1.reasoningEffort).toBe(s2.reasoningEffort);
      expect(s1.reasoningEffort).toBe("medium");
      expect(r1).toHaveBeenCalledWith("Reasoning effort: medium");
      expect(r2).toHaveBeenCalledWith("Reasoning effort: medium");
    });
  });

  describe("the off collision — display-toggle aliases are gone", () => {
    it("/effort off sets effort (NOT display)", async () => {
      const session = makeSession();
      session.showReasoning = true;  // start with display ON
      const { ctx, reply } = makeCtx({ session });
      await handleEffort("/effort off", ctx);
      // effort is set to "off"
      expect(session.reasoningEffort).toBe("off");
      // display was NOT toggled
      expect(session.showReasoning).toBe(true);
      expect(reply).toHaveBeenCalledWith("Reasoning effort: off");
    });

    it("/effort on is NOT a display alias (falls through to status echo)", async () => {
      const session = makeSession();
      session.showReasoning = false;
      const { ctx, reply } = makeCtx({ session });
      await handleEffort("/effort on", ctx);
      // display was NOT turned on
      expect(session.showReasoning).toBe(false);
      // status echo (no arg change)
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0]![0]).toMatch(/^Reasoning: /);
    });
  });

  describe("display toggle — show/hide only", () => {
    it("/effort show sets showReasoning = true", async () => {
      const session = makeSession();
      session.showReasoning = false;
      const { ctx, reply } = makeCtx({ session });
      await handleEffort("/effort show", ctx);
      expect(session.showReasoning).toBe(true);
      expect(session.reasoningEffort).toBeNull();
      expect(reply).toHaveBeenCalledWith("Reasoning display: on");
    });

    it("/effort hide sets showReasoning = false", async () => {
      const session = makeSession();
      session.showReasoning = true;
      const { ctx, reply } = makeCtx({ session });
      await handleEffort("/effort hide", ctx);
      expect(session.showReasoning).toBe(false);
      expect(session.reasoningEffort).toBeNull();
      expect(reply).toHaveBeenCalledWith("Reasoning display: off");
    });
  });

  describe("ACP guard — getActiveSession undefined", () => {
    it("replies 'not supported on this transport' (capability-based check, runs BEFORE the no-session path)", async () => {
      // Transport without the getActiveSession method (ACP case)
      const acpTransport: { getActiveSession?: undefined } = {};
      const { ctx, reply } = makeCtx({ transport: acpTransport as { getActiveSession?: undefined } });
      const out = await handleEffort("/effort medium", ctx);
      expect(out).toBe(true);
      expect(reply).toHaveBeenCalledWith("not supported on this transport");
    });
  });

  describe("no active session on a transport that implements getActiveSession", () => {
    it("replies 'No active session.'", async () => {
      const transport = { getActiveSession: () => null };
      const { ctx, reply } = makeCtx({ transport });
      await handleEffort("/effort medium", ctx);
      expect(reply).toHaveBeenCalledWith("No active session.");
    });
  });

  describe("bare /effort — status echo", () => {
    it("echoes current effort + display state", async () => {
      const session = makeSession();
      session.showReasoning = true;
      session.reasoningEffort = "xhigh";
      const { ctx, reply } = makeCtx({ session });
      await handleEffort("/effort", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning: effort=xhigh, display=show");
    });

    it("echoes 'default' when reasoningEffort is null", async () => {
      const session = makeSession();
      session.reasoningEffort = null;
      session.showReasoning = false;
      const { ctx, reply } = makeCtx({ session });
      await handleEffort("/effort", ctx);
      expect(reply).toHaveBeenCalledWith("Reasoning: effort=default, display=hide");
    });
  });

  describe("case insensitivity + whitespace", () => {
    it("/EFFORT HIGH (uppercase) works", async () => {
      const { ctx } = makeCtx();
      await handleEffort("/EFFORT HIGH", ctx);
      const sess = (ctx.transport as unknown as { getActiveSession: () => Session }).getActiveSession()!;
      expect(sess.reasoningEffort).toBe("high");
    });

    it("/effort   xhigh   (extra spaces) works", async () => {
      const { ctx } = makeCtx();
      await handleEffort("/effort   xhigh   ", ctx);
      const sess = (ctx.transport as unknown as { getActiveSession: () => Session }).getActiveSession()!;
      expect(sess.reasoningEffort).toBe("xhigh");
    });
  });

  describe("unknown arg falls through to status echo (no error)", () => {
    it("/effort banana echoes status", async () => {
      const session = makeSession();
      const { ctx, reply } = makeCtx({ session });
      await handleEffort("/effort banana", ctx);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0]![0]).toMatch(/^Reasoning: /);
      // no state change
      expect(session.reasoningEffort).toBeNull();
      expect(session.showReasoning).toBe(false);
    });
  });
});
