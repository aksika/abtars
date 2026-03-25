import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodingMode } from "./coding-mode.js";

// Mock AcpTransport
vi.mock("./acp-transport.js", () => ({
  AcpTransport: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("ok"),
    destroy: vi.fn(),
    resetSession: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("CodingMode", () => {
  let cm: CodingMode;

  beforeEach(() => {
    vi.clearAllMocks();
    cm = new CodingMode("/usr/bin/kiro-cli", "/tmp/project", "test-model");
  });

  it("has() returns false for unknown session", () => {
    expect(cm.has("s1")).toBe(false);
  });

  it("getTransport() returns null before start", () => {
    expect(cm.getTransport()).toBeNull();
  });

  it("start() creates transport and adds session", async () => {
    await cm.start("s1");
    expect(cm.has("s1")).toBe(true);
    expect(cm.getTransport()).not.toBeNull();
  });

  it("start() reuses transport for second session", async () => {
    await cm.start("s1");
    const t1 = cm.getTransport();
    await cm.start("s2");
    expect(cm.getTransport()).toBe(t1);
    expect(cm.has("s1")).toBe(true);
    expect(cm.has("s2")).toBe(true);
  });

  it("stop() removes session, destroys transport when last session removed", async () => {
    await cm.start("s1");
    const transport = cm.getTransport()!;
    await cm.stop("s1");
    expect(cm.has("s1")).toBe(false);
    expect(cm.getTransport()).toBeNull();
    expect(transport.destroy).toHaveBeenCalled();
  });

  it("stop() keeps transport alive if other sessions remain", async () => {
    await cm.start("s1");
    await cm.start("s2");
    await cm.stop("s1");
    expect(cm.has("s1")).toBe(false);
    expect(cm.getTransport()).not.toBeNull();
  });
});
