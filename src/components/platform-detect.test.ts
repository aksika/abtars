import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyResume } from "./platform-detect.js";
import { PowerTransitionStore } from "../capabilities/power/power-transition-store.js";
import type { PowerTransitionState } from "../capabilities/power/types.js";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

const platformMock = vi.hoisted(() => vi.fn());
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: platformMock };
});

const HOUR = 3600_000;

function ownedMarker(overrides: Partial<PowerTransitionState> = {}): PowerTransitionState {
  return {
    state: "suspending",
    taskId: "hardware-sleep",
    requestedAt: Date.now() - 60_000,
    expectedWakeAt: Date.now() + 8 * HOUR,
    expiresAt: Date.now() + 10 * HOUR,
    ...overrides,
  };
}

describe("classifyResume — bridge-owned power transition (#1532)", () => {
  let root: string;
  let store: PowerTransitionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pd-transition-"));
    store = new PowerTransitionStore(join(root, "power-transition.json"));
    execSyncMock.mockReset();
    platformMock.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const mockMacOS = (out: string): void => {
    platformMock.mockReturnValue("darwin");
    execSyncMock.mockReturnValue(out);
  };

  it("returns dark inside the owned window and never consults the OS log", () => {
    const now = Date.now();
    store.write(ownedMarker({ requestedAt: now - 60_000, expectedWakeAt: now + 8 * HOUR, expiresAt: now + 10 * HOUR }));
    mockMacOS("2026-08-02 03:15:00 +0000 Wake  [CDN] assertion: system-wake\n");
    expect(classifyResume({ transitionStore: store, now })).toBe("dark");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("returns full at and after the expected wake, ignoring a stale DarkWake OS line", () => {
    const now = Date.now();
    store.write(ownedMarker({ requestedAt: now - 8 * HOUR - 60_000, expectedWakeAt: now, expiresAt: now + 2 * HOUR }));
    mockMacOS("2026-08-02 07:55:00 +0000 DarkWake  [CDN] assertion: system-wake\n");
    expect(classifyResume({ transitionStore: store, now })).toBe("full");
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(classifyResume({ transitionStore: store, now: now + HOUR })).toBe("full");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("falls through to OS detection when no marker exists", () => {
    mockMacOS("2026-08-02 03:15:00 +0000 DarkWake  [CDN] assertion: system-wake\n");
    expect(classifyResume({ transitionStore: store })).toBe("dark");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to OS detection when the marker file is corrupt", () => {
    writeFileSync(join(root, "power-transition.json"), "{not json", "utf-8");
    mockMacOS("2026-08-02 03:15:00 +0000 Wake  [CDN] assertion: system-wake\n");
    expect(classifyResume({ transitionStore: store })).toBe("full");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  const malformedMarkers: Array<[string, Record<string, unknown>]> = [
    ["wrong state", { ...ownedMarker(), state: "waking" }],
    ["wrong taskId", { ...ownedMarker(), taskId: "memory-sleep" }],
    ["missing timestamps", { ...ownedMarker(), requestedAt: null, expectedWakeAt: null, expiresAt: null }],
    ["reversed ordering (requestedAt after expectedWakeAt)", { ...ownedMarker(), requestedAt: Date.now() + 2 * HOUR, expectedWakeAt: Date.now() - HOUR }],
    ["unbounded expiry (missing expiresAt)", { ...ownedMarker(), expiresAt: null }],
  ];

  it.each(malformedMarkers)("falls through on malformed marker: %s", (_name, marker) => {
    writeFileSync(join(root, "power-transition.json"), JSON.stringify(marker), "utf-8");
    mockMacOS("2026-08-02 07:55:00 +0000 Wake  [CDN] assertion: system-wake\n");
    expect(classifyResume({ transitionStore: store })).toBe("full");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("falls through when requestedAt is in the future", () => {
    const now = Date.now();
    store.write(ownedMarker({ requestedAt: now + 60_000, expectedWakeAt: now + 8 * HOUR, expiresAt: now + 10 * HOUR }));
    mockMacOS("2026-08-02 03:15:00 +0000 DarkWake  [CDN] assertion: system-wake\n");
    expect(classifyResume({ transitionStore: store, now })).toBe("dark");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("falls through on expired markers and still returns unknown when OS parsing finds nothing", () => {
    store.write(ownedMarker({ requestedAt: Date.now() - 2 * HOUR, expectedWakeAt: Date.now() - HOUR, expiresAt: Date.now() - 60_000 }));
    mockMacOS("2026-08-02 03:15:00 +0000 Sleep  [CDN] no wake records\n");
    expect(classifyResume({ transitionStore: store })).toBe("unknown");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("falls through when the classifier clock is past marker expiry", () => {
    const now = Date.now();
    const expiresAt = now + HOUR;
    store.write(ownedMarker({ requestedAt: now - HOUR, expectedWakeAt: now + 30 * 60_000, expiresAt }));
    mockMacOS("2026-08-02 03:15:00 +0000 DarkWake  [CDN] assertion: system-wake\n");
    expect(classifyResume({ transitionStore: store, now: expiresAt + 1 })).toBe("dark");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the default runtime store contract without a marker (no options)", () => {
    const result = classifyResume();
    expect(["dark", "full", "unknown"]).toContain(result);
  });
});
