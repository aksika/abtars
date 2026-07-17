import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBootCtx } from "./context.js";

const mockLoadPiConfig = vi.hoisted(() => vi.fn());
const mockValidateAliases = vi.hoisted(() => vi.fn());
const mockResolvePiInstallation = vi.hoisted(() => vi.fn());
const mockRequireTaskDatabase = vi.hoisted(() => vi.fn());
const mockPiRunStore = vi.hoisted(() => vi.fn(function (_opts: unknown) {
  return {
    generateId: vi.fn(() => "test-run-id"),
    recoverNonterminal: vi.fn(() => ({ interrupted: 0, queuedCardIds: [] })),
  };
}));
const mockPiExecutor = vi.hoisted(() => vi.fn(function () {
  return {
    onTransition: vi.fn(),
    startWithClaim: vi.fn(),
  };
}));
const mockPiRunService = vi.hoisted(() => vi.fn(function () {
  return {
    executor: {},
    store: {},
    config: {},
  };
}));
const mockRegister = vi.hoisted(() => vi.fn());

vi.mock("../components/pi-executor/config.js", () => ({
  loadPiConfig: mockLoadPiConfig,
  validatePiWorkspaceAliases: mockValidateAliases,
}));

vi.mock("../components/pi-installation.js", () => ({
  resolvePiInstallation: mockResolvePiInstallation,
  clearPiCache: vi.fn(),
}));

vi.mock("../components/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../components/tasks/kanban-board.js", () => ({
  requireTaskDatabase: mockRequireTaskDatabase,
}));

vi.mock("../components/pi-executor/pi-run-store.js", () => ({
  PiRunStore: mockPiRunStore,
}));

vi.mock("../components/pi-executor/pi-executor.js", () => ({
  PiExecutor: mockPiExecutor,
}));

vi.mock("../components/pi-executor/pi-run-service.js", () => ({
  PiRunService: mockPiRunService,
}));

vi.mock("../components/peer-transport/peer-health.js", () => ({
  getHealthStore: vi.fn(() => ({
    register: mockRegister,
    setHealth: vi.fn(),
    getValues: vi.fn(() => []),
  })),
}));

vi.mock("../components/peer-transport/remote-pi-registry.js", () => ({
  setRemotePiComponents: vi.fn(),
}));

vi.mock("../components/peer-transport/remote-pi-event-producer.js", () => ({
  RemotePiEventProducer: vi.fn(),
}));

vi.mock("../components/peer-transport/remote-pi-delivery.js", () => ({
  RemotePiDeliveryManager: vi.fn(),
}));

vi.mock("../components/peer-transport/remote-pi-control-handler.js", () => ({
  RemotePiControlHandler: vi.fn(),
}));

vi.mock("../components/peer-transport/remote-pi-origin-projection.js", () => ({
  RemotePiOriginReducer: vi.fn(),
  SqliteProjectionStore: vi.fn(),
}));

vi.mock("../components/commands/handlers-pi.js", () => ({
  setPiService: vi.fn(),
}));

vi.mock("../components/reconciler.js", () => ({
  setPiService: vi.fn(),
  requestReconcile: vi.fn(),
}));

describe("phasePiExecutor — #1440 disabled seed and enabled boot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateAliases.mockReturnValue({});
    mockRequireTaskDatabase.mockReturnValue({ exec: vi.fn() });
  });

  it("skips when loadPiConfig returns null (disabled or missing)", async () => {
    mockLoadPiConfig.mockReturnValue(null);
    const ctx = createBootCtx();
    const { phasePiExecutor } = await import("./phase-pi-executor.js");
    await phasePiExecutor(ctx);

    expect(mockRegister).not.toHaveBeenCalled();
    expect(ctx.piExecutorService).toBeUndefined();
  });

  it("skips when pi installation is absent", async () => {
    mockLoadPiConfig.mockReturnValue({ enabled: true, command: "pi", workspaceAliases: { work: { path: "/tmp" } } });
    mockResolvePiInstallation.mockReturnValue({ state: "absent" });
    const ctx = createBootCtx();
    const { phasePiExecutor } = await import("./phase-pi-executor.js");
    await phasePiExecutor(ctx);

    expect(ctx.piExecutorService).toBeUndefined();
  });

  it("registers capabilities when config is valid and pi is compatible", async () => {
    mockLoadPiConfig.mockReturnValue({
      enabled: true, command: "pi",
      workspaceAliases: { work: { path: "/tmp" }, home: { path: "/home" } },
    });
    mockResolvePiInstallation.mockReturnValue({
      state: "compatible",
      installation: { version: "0.80.7", source: "path" },
    });
    const ctx = createBootCtx();
    const { phasePiExecutor } = await import("./phase-pi-executor.js");
    await phasePiExecutor(ctx);

    expect(mockRegister).toHaveBeenCalledWith("pi-executor-boot", expect.arrayContaining([
      "pi-executor", "workspace:work", "workspace:home",
    ]));
    expect(ctx.piExecutorService).not.toBeUndefined();
  });
});
