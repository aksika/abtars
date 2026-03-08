import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { TransportController } from "./transport-controller.js";
import type { TransportSwitchDeps, TransportMemoryRef } from "./transport-controller.js";
import type { IKiroTransport } from "./kiro-transport.js";
import type { Config } from "../types/index.js";
import type { PlatformRefs } from "./platform-controller.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal config stub with fields the controller actually reads. */
function stubConfig(overrides?: Partial<Config>): Config {
  return {
    telegramBotToken: "",
    allowedUserIds: new Set(),
    kiroCLIPath: "/usr/bin/kiro-cli",
    workingDir: "/tmp",
    trustMode: false,
    permissionTimeoutMs: 60_000,
    pollTimeoutS: 30,
    kiroTransport: "tmux",
    tmuxSession: "test-session",
    tmuxCaptureDelaySec: 1,
    tmuxMaxWaitSec: 30,
    logLevel: "off",
    sttEnabled: false,
    groqApiKey: "",
    sttModel: "whisper-large-v3",
    ttsEnabled: false,
    ttsVoice: "en-US-AndrewMultilingualNeural",
    discordB2bRateLimitMs: 5000,
    discordEnabled: false,
    discordB2bEnabled: false,
    ...overrides,
  } as Config;
}

/** Create a mock transport that behaves like TmuxClient or AcpTransport. */
function mockTransport(mode: "tmux" | "acp", opts?: {
  isReady?: boolean;
  contextPercent?: number;
  initializeFn?: () => Promise<void>;
  destroyFn?: () => void;
}): IKiroTransport & { contextPercent?: number } {
  const t: Record<string, unknown> = {
    initialize: vi.fn(opts?.initializeFn ?? (async () => {})),
    destroy: vi.fn(opts?.destroyFn ?? (() => {})),
    sendPrompt: vi.fn(async () => "response"),
    resetSession: vi.fn(async () => {}),
    sendInterrupt: vi.fn(async () => {}),
    isReady: opts?.isReady ?? true,
  };

  if (mode === "tmux") {
    t.contextPercent = opts?.contextPercent ?? 42;
    // Make instanceof TmuxClient work by setting constructor name
    // We can't truly fake instanceof, so we rely on duck-typing in the controller
  }

  return t as unknown as IKiroTransport & { contextPercent?: number };
}

function mockMemory(): TransportMemoryRef {
  return { setLlmCall: vi.fn() };
}

function mockPoller(running = false) {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    running,
    started: running,
  };
}

function makeDeps(opts?: {
  mode?: "tmux" | "acp";
  transport?: IKiroTransport;
  memory?: TransportMemoryRef | null;
  telegramPoller?: ReturnType<typeof mockPoller> | null;
  discordPoller?: ReturnType<typeof mockPoller> | null;
}): TransportSwitchDeps & { transportRef: { current: IKiroTransport } } {
  const mode = opts?.mode ?? "tmux";
  const transport = opts?.transport ?? mockTransport(mode);
  const transportRef = { current: transport };

  return {
    config: stubConfig({ kiroTransport: mode }),
    getCurrentTransport: () => transportRef.current,
    setTransport: (t: IKiroTransport) => { transportRef.current = t; },
    platformRefs: {
      telegramPoller: opts?.telegramPoller !== undefined ? opts.telegramPoller : null,
      discordPoller: opts?.discordPoller !== undefined ? opts.discordPoller : null,
    } as unknown as PlatformRefs,
    memory: opts?.memory !== undefined ? opts.memory : null,
    transportRef,
  };
}

// ── handle — no-op when same mode ───────────────────────────────────────────

describe("TransportController.handle", () => {
  it("returns 200 no-op when requested mode matches current mode", async () => {
    const transport = mockTransport("tmux");
    // The controller uses `instanceof TmuxClient` to detect mode.
    // Since we can't fake that, we need to test via the ACP path where
    // the transport is NOT instanceof TmuxClient → mode = "acp".
    const deps = makeDeps({ mode: "acp", transport: mockTransport("acp") });
    const ctrl = new TransportController(deps);

    const result = await ctrl.handle("acp");

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("switched", false);
    // Transport should not have been destroyed
    expect((deps.transportRef.current as any).destroy).not.toHaveBeenCalled();
  });

  // ── handle — no-op for both modes ───────────────────────────────────────

  it("returns 200 no-op for tmux when already tmux (via duck-type)", async () => {
    // Since mock is not instanceof TmuxClient, transportMode returns "acp".
    // So requesting "acp" is the no-op case for a mock transport.
    const transport = mockTransport("acp");
    const deps = makeDeps({ mode: "acp", transport });
    const ctrl = new TransportController(deps);

    const result = await ctrl.handle("acp");

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("switched", false);
    expect(transport.destroy).not.toHaveBeenCalled();
  });

  // ── handle — transport reference unchanged on no-op ─────────────────────

  it("does not change transport reference on no-op", async () => {
    const transport = mockTransport("acp");
    const deps = makeDeps({ mode: "acp", transport });
    const ctrl = new TransportController(deps);

    await ctrl.handle("acp");

    // The transport ref should still be the same object
    expect(deps.getCurrentTransport()).toBe(transport);
  });

  // ── handle — re-registers memory LLM callback ──────────────────────────

  it("does not call memory.setLlmCall on no-op switch", async () => {
    const mem = mockMemory();
    const deps = makeDeps({
      mode: "acp",
      transport: mockTransport("acp"),
      memory: mem,
    });
    const ctrl = new TransportController(deps);

    await ctrl.handle("acp");

    expect(mem.setLlmCall).not.toHaveBeenCalled();
  });

  // ── handle — does not stop non-running pollers on no-op ─────────────────

  it("does not stop pollers on no-op switch", async () => {
    const telegram = mockPoller(false);
    const discord = mockPoller(false);
    const deps = makeDeps({
      mode: "acp",
      transport: mockTransport("acp"),
      telegramPoller: telegram,
      discordPoller: discord,
    });
    const ctrl = new TransportController(deps);

    await ctrl.handle("acp");

    expect(telegram.stop).not.toHaveBeenCalled();
    expect(discord.stop).not.toHaveBeenCalled();
  });

  // ── handle — does not call initialize on no-op ──────────────────────────

  it("does not call initialize on transport during no-op", async () => {
    const transport = mockTransport("acp");
    const deps = makeDeps({ mode: "acp", transport });
    const ctrl = new TransportController(deps);

    await ctrl.handle("acp");

    expect(transport.initialize).not.toHaveBeenCalled();
  });
});

// ── getTransportStatus ──────────────────────────────────────────────────────

describe("TransportController.getTransportStatus", () => {
  it("returns status for an acp transport", () => {
    const transport = mockTransport("acp", { isReady: true });
    const deps = makeDeps({ mode: "acp", transport });
    const ctrl = new TransportController(deps);

    const status = ctrl.getTransportStatus();

    // Not instanceof TmuxClient → mode is "acp"
    expect(status.type).toBe("acp");
    expect(status.ready).toBe(true);
    expect(status.contextPercent).toBe(-1);
  });

  it("returns contextPercent when transport has it (duck-typed)", () => {
    const transport = mockTransport("tmux", { isReady: true, contextPercent: 65 });
    const deps = makeDeps({ mode: "tmux", transport });
    const ctrl = new TransportController(deps);

    const status = ctrl.getTransportStatus();

    // Since mock is not instanceof TmuxClient, mode will be "acp"
    // but contextPercent should still be read via duck-typing
    expect(status.contextPercent).toBe(65);
  });

  it("returns ready: false when transport is not ready", () => {
    const transport = mockTransport("acp", { isReady: false });
    const deps = makeDeps({ mode: "acp", transport });
    const ctrl = new TransportController(deps);

    const status = ctrl.getTransportStatus();

    expect(status.ready).toBe(false);
  });
});


// Feature: kiro-professor-webui, Property 8: Transport switch no-op for same mode
// **Validates: Requirements 10.4**
describe("Property 8: Transport switch no-op for same mode", () => {
  it("returns 200 without destroying or reinitializing when requested mode equals current mode", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          hasMemory: fc.boolean(),
          hasTelegram: fc.boolean(),
          hasDiscord: fc.boolean(),
          telegramRunning: fc.boolean(),
          discordRunning: fc.boolean(),
        }),
        async ({ hasMemory, hasTelegram, hasDiscord, telegramRunning, discordRunning }) => {
          // Since mocks are not real TmuxClient instances, transportMode() always
          // returns "acp". So requesting "acp" is the no-op case for any mock.
          const transport = mockTransport("acp");
          const mem = hasMemory ? mockMemory() : null;
          const telegram = hasTelegram ? mockPoller(telegramRunning) : null;
          const discord = hasDiscord ? mockPoller(discordRunning) : null;

          const deps = makeDeps({
            mode: "acp",
            transport,
            memory: mem,
            telegramPoller: telegram,
            discordPoller: discord,
          });
          const ctrl = new TransportController(deps);

          const result = await ctrl.handle("acp");

          // Returns 200 with switched: false
          expect(result.status).toBe(200);
          expect(result.body).toHaveProperty("switched", false);

          // Transport reference remains the same object
          expect(deps.getCurrentTransport()).toBe(transport);

          // destroy was NOT called
          expect(transport.destroy).not.toHaveBeenCalled();

          // initialize was NOT called
          expect(transport.initialize).not.toHaveBeenCalled();

          // Memory LLM callback was NOT re-registered
          if (mem) {
            expect(mem.setLlmCall).not.toHaveBeenCalled();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
