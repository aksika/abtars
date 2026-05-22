import { describe, it, expect, vi } from "vitest";
import { createCronCallback } from "./phase-pipeline-deps.js";
import type { BootCtx } from "./context.js";

describe("createCronCallback (#566)", () => {
  function makeCtx(): BootCtx {
    return {
      platforms: { telegram: true },
      telegramAdapter: {
        sendMessage: vi.fn().mockResolvedValue(1),
        sendDocument: vi.fn().mockResolvedValue(2),
      },
    } as unknown as BootCtx;
  }

  it("sends inline message for all tasks", () => {
    const ctx = makeCtx();
    const cb = createCronCallback(ctx);
    cb(123, "Check emails", "✅ 3 emails summarized");
    expect(ctx.telegramAdapter!.sendMessage).toHaveBeenCalledWith("123", expect.stringContaining("✅ 3 emails summarized"));
  });

  it("does NOT send document when no DoD files", () => {
    const ctx = makeCtx();
    const cb = createCronCallback(ctx);
    cb(123, "Check emails", "✅ done");
    expect(ctx.telegramAdapter!.sendDocument).not.toHaveBeenCalled();
  });

  it("does NOT send document when dodFiles is empty array", () => {
    const ctx = makeCtx();
    const cb = createCronCallback(ctx);
    cb(123, "Check emails", "✅ done", []);
    expect(ctx.telegramAdapter!.sendDocument).not.toHaveBeenCalled();
  });

  it("sends document for each DoD file", () => {
    const ctx = makeCtx();
    const cb = createCronCallback(ctx);
    cb(123, "Daily AI report", "✅ Report written", ["/home/user/.abtars/reports/AI-Daily.md", "/home/user/.abtars/reports/summary.md"]);
    expect(ctx.telegramAdapter!.sendDocument).toHaveBeenCalledTimes(2);
    expect(ctx.telegramAdapter!.sendDocument).toHaveBeenCalledWith("123", "/home/user/.abtars/reports/AI-Daily.md", expect.any(String));
    expect(ctx.telegramAdapter!.sendDocument).toHaveBeenCalledWith("123", "/home/user/.abtars/reports/summary.md", expect.any(String));
  });
});
