import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

vi.mock("../paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../paths.js")>();
  return { ...actual, abtarsHome: () => tmpDir };
});

let mockStartedAt = 1000;

vi.mock("./transport/bridge-lock-transport.js", () => ({
  readBridgeLockField: (key: string) => {
    if (key === "pid") return process.pid;
    if (key === "startedAt") return mockStartedAt;
    return null;
  },
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "snapshot-test-"));
  mkdirSync(join(tmpDir, "state"), { recursive: true });
  process.env["ABTARS_HOME"] = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["ABTARS_HOME"];
});

describe("RuntimeHealthSnapshot", () => {
  it("initSnapshot creates a valid snapshot file", async () => {
    mockStartedAt = 1000;
    const { initSnapshot } = await import("./runtime-health-snapshot.js");
    initSnapshot(process.pid, 1000);
    const filePath = join(tmpDir, "state", "runtime-health-v1.json");
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content.schemaVersion).toBe(1);
    expect(content.bridge.pid).toBe(process.pid);
  });

  it("readSnapshot returns trusted for a valid fresh snapshot", async () => {
    const startedAt = 1000;
    mockStartedAt = startedAt;
    const { initSnapshot, readSnapshot } = await import("./runtime-health-snapshot.js");
    initSnapshot(process.pid, startedAt);
    const result = readSnapshot();
    expect(result.trust).toBe("trusted");
    expect(result.data).not.toBeNull();
  });

  it("updatePeerApiState modifies snapshot", async () => {
    mockStartedAt = 1000;
    const { initSnapshot, updatePeerApiState, readSnapshot } = await import("./runtime-health-snapshot.js");
    initSnapshot(process.pid, 1000);
    updatePeerApiState("listening");
    const result = readSnapshot();
    expect(result.data?.peerApi.state).toBe("listening");
  });

  it("updateActiveCardIds updates the card list", async () => {
    mockStartedAt = 1000;
    const { initSnapshot, updateActiveCardIds, readSnapshot } = await import("./runtime-health-snapshot.js");
    initSnapshot(process.pid, 1000);
    updateActiveCardIds([1, 2, 3]);
    const result = readSnapshot();
    expect(result.data?.activeCardIds).toEqual([1, 2, 3]);
  });

  it("readSnapshot returns missing when no file exists", async () => {
    const { readSnapshot } = await import("./runtime-health-snapshot.js");
    const result = readSnapshot();
    expect(result.trust).toBe("missing");
    expect(result.data).toBeNull();
  });
});
