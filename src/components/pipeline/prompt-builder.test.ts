import { describe, it, expect, vi } from "vitest";
import { buildPrompt } from "./prompt-builder.js";
import { createDisabledRuntime } from "../memory-runtime.js";

vi.mock("../spin.js", () => ({ spin: { getSessionById: vi.fn(() => undefined) } }));

describe("buildPrompt", () => {
  it("uses the explicit disabled runtime without a manager-shaped memory object", async () => {
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      "hello",
      {
        memoryRuntime: createDisabledRuntime(),
        memoryConfig: { memoryEnabled: false, memoryDir: "" },
        sessionManager: { getActiveSessionId: () => "master_A_1" },
        conversationBuffer: { drain: () => "" },
        contextPercent: -1,
      } as never,
      { byUserId: new Map([["master", { role: "master" }]]) } as never,
    );
    expect(result.prompt).toContain("hello");
  });
});
