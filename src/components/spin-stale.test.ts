/**
 * spin-stale.test.ts — #1274 regression: checkStaleWorkers releases the
 * in-memory concurrency slot so the type can dispatch again.
 *
 * Separate file because vi.mock() must be hoisted at module scope; mixing a
 * kanban-board mock into spin.spin.test.ts would break the other tests there
 * that rely on a real (in-memory SQLite) kanban board.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoisted stubs ────────────────────────────────────────────────────────────
const { STALE_CARD_ID, mockKanbanGetCard, mockKanbanFail, mockKanbanList } = vi.hoisted(() => {
  const STALE_CARD_ID = 9001;
  const staleCard = {
    id: STALE_CARD_ID,
    status: "running",
    // 10 min ago — well past WORKER_STALE_MS (300s default)
    updated_at: new Date(Date.now() - 10 * 60_000).toISOString().replace("Z", ""),
  };
  return {
    STALE_CARD_ID,
    mockKanbanGetCard: vi.fn((id: number) => id === STALE_CARD_ID ? staleCard : undefined),
    mockKanbanFail: vi.fn(),
    mockKanbanList: vi.fn(() => []),
  };
});

vi.mock("./tasks/kanban-board.js", () => ({
  kanbanGetCard: mockKanbanGetCard,
  kanbanFail: mockKanbanFail,
  kanbanList: mockKanbanList,
  kanbanEnqueue: vi.fn(() => 1),
  kanbanRunning: vi.fn(),
  kanbanComplete: vi.fn(),
  kanbanRetryOrFail: vi.fn(),
  isUnblocked: vi.fn(() => true),
}));

// Other mocks required by Spin's side-effect imports
vi.mock("./transport/bridge-lock-transport.js", () => ({
  updateBridgeLockField: vi.fn(),
  trackAcpPid: vi.fn(),
}));
vi.mock("./transport/orc-tools.js", () => ({ setActiveOrcCard: vi.fn() }));
vi.mock("./spin-notifications.js", () => ({ drainOrcNotifications: () => [] }));
vi.mock("./tasks/kanban-channel.js", () => ({ channelUnread: () => [] }));
vi.mock("../utils/local-time.js", () => ({ localDateTime: () => "2026-07-01 12:00" }));
vi.mock("./soul-bundle.js", () => ({ buildSoulBundle: () => "" }));

import { Spin } from "./spin.js";
import { setUserRegistryOverride, type UserRegistry, type UserEntry } from "./user-registry.js";

function makeRegistry(users: UserEntry[]): UserRegistry {
  const r: UserRegistry = { users, byPlatformId: new Map(), byUserId: new Map() };
  for (const u of users) r.byUserId.set(u.userId, u);
  return r;
}

describe("#1274 — checkStaleWorkers releases slot + drains queue", () => {
  let spin: Spin;

  beforeEach(() => {
    spin = new Spin();
    spin.setRuntime({ session: vi.fn(), complete: vi.fn(async () => "ok"), lastUsage: null } as any);
    setUserRegistryOverride(makeRegistry([
      { userId: "aksika", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 111 } },
    ]));
    vi.clearAllMocks();
    // Re-seed the stale card mock after clearAllMocks
    const staleCard = {
      id: STALE_CARD_ID,
      status: "running",
      updated_at: new Date(Date.now() - 10 * 60_000).toISOString().replace("Z", ""),
    };
    mockKanbanGetCard.mockImplementation((id: number) => id === STALE_CARD_ID ? staleCard : undefined);
    mockKanbanList.mockReturnValue([]);
  });

  afterEach(() => {
    setUserRegistryOverride(null);
  });

  it("stale card is failed and removed from running set", () => {
    const runningMap: Map<string, Set<number>> = (spin as any).running;
    runningMap.set("W", new Set([STALE_CARD_ID]));

    (spin as any).checkStaleWorkers();

    expect(mockKanbanFail).toHaveBeenCalledWith(STALE_CARD_ID, "stale — no activity");
    expect(runningMap.get("W")?.has(STALE_CARD_ID)).toBe(false);
  });

  it("drainQueued is called when a slot is freed (queued card can proceed)", () => {
    // Put the stale card in running
    const runningMap: Map<string, Set<number>> = (spin as any).running;
    runningMap.set("W", new Set([STALE_CARD_ID]));

    // Queue a second card that should be dispatched once slot is free
    const QUEUED_ID = 9002;
    mockKanbanList.mockReturnValue([{ id: QUEUED_ID, title: "queued task", type: "W", status: "queued", source: "task" }]);

    const dispatchSpy = vi.spyOn(spin, "dispatch");

    (spin as any).checkStaleWorkers();

    // drainQueued should have tried to dispatch the queued card
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ cardId: QUEUED_ID, type: "W" }));
  });

  it("no freed slot → drainQueued not called", () => {
    // healthy card (not stale) — mockKanbanGetCard returns status:"done" for it
    const HEALTHY_ID = 9003;
    mockKanbanGetCard.mockImplementation((id: number) => id === HEALTHY_ID
      ? { id: HEALTHY_ID, status: "done", updated_at: new Date().toISOString().replace("Z", "") }
      : undefined);

    const runningMap: Map<string, Set<number>> = (spin as any).running;
    runningMap.set("W", new Set([HEALTHY_ID]));

    const dispatchSpy = vi.spyOn(spin, "dispatch");
    (spin as any).checkStaleWorkers();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(mockKanbanFail).not.toHaveBeenCalled();
  });
});
