import { describe, it, expect, vi } from "vitest";
import { PlatformController } from "./platform-controller.js";
import type { PlatformRefs } from "./platform-controller.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock poller with start/stop methods and optional overrides. */
function mockPoller(overrides?: {
  startFn?: () => void | Promise<void>;
  stopFn?: () => void;
}) {
  return {
    start: vi.fn(overrides?.startFn ?? (() => {})),
    stop: vi.fn(overrides?.stopFn ?? (() => {})),
  };
}

/** Build PlatformRefs with both pollers configured by default. */
function makeRefs(opts?: {
  telegram?: ReturnType<typeof mockPoller> | null;
  discord?: ReturnType<typeof mockPoller> | null;
}): PlatformRefs {
  return {
    telegramPoller: opts?.telegram !== undefined ? opts.telegram : mockPoller(),
    discordPoller: opts?.discord !== undefined ? opts.discord : mockPoller(),
  } as unknown as PlatformRefs;
}

// ── handle — valid actions ──────────────────────────────────────────────────

describe("PlatformController.handle", () => {
  it("starts telegram and returns 200 with running: true", async () => {
    const refs = makeRefs();
    const ctrl = new PlatformController(refs);

    const result = await ctrl.handle("telegram", "start");

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ platform: "telegram", running: true });
    expect(refs.telegramPoller!.start).toHaveBeenCalledOnce();
  });

  it("stops telegram and returns 200 with running: false", async () => {
    const refs = makeRefs();
    const ctrl = new PlatformController(refs);

    const result = await ctrl.handle("telegram", "stop");

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ platform: "telegram", running: false });
    expect(refs.telegramPoller!.stop).toHaveBeenCalledOnce();
  });

  it("starts discord and returns 200 with running: true", async () => {
    const refs = makeRefs();
    const ctrl = new PlatformController(refs);

    const result = await ctrl.handle("discord", "start");

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ platform: "discord", running: true });
    expect(refs.discordPoller!.start).toHaveBeenCalledOnce();
  });

  it("stops discord and returns 200 with running: false", async () => {
    const refs = makeRefs();
    const ctrl = new PlatformController(refs);

    const result = await ctrl.handle("discord", "stop");

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ platform: "discord", running: false });
    expect(refs.discordPoller!.stop).toHaveBeenCalledOnce();
  });

  // ── handle — 409 not configured ─────────────────────────────────────────

  it("returns 409 when telegram poller is null", async () => {
    const ctrl = new PlatformController(makeRefs({ telegram: null }));

    const result = await ctrl.handle("telegram", "start");

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: "telegram is not configured" });
  });

  it("returns 409 when discord poller is null", async () => {
    const ctrl = new PlatformController(makeRefs({ discord: null }));

    const result = await ctrl.handle("discord", "stop");

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: "discord is not configured" });
  });

  // ── handle — 400 invalid platform/action ────────────────────────────────

  it("returns 400 for invalid platform", async () => {
    const ctrl = new PlatformController(makeRefs());

    const result = await ctrl.handle("slack", "start");

    expect(result.status).toBe(400);
    expect(result.body).toHaveProperty("error");
  });

  it("returns 400 for invalid action", async () => {
    const ctrl = new PlatformController(makeRefs());

    const result = await ctrl.handle("telegram", "restart");

    expect(result.status).toBe(400);
    expect(result.body).toHaveProperty("error");
  });

  it("returns 400 for both invalid platform and action", async () => {
    const ctrl = new PlatformController(makeRefs());

    const result = await ctrl.handle("unknown", "nope");

    expect(result.status).toBe(400);
  });

  // ── handle — 500 on poller error ────────────────────────────────────────

  it("returns 500 when telegram start throws", async () => {
    const telegram = mockPoller({
      startFn: () => { throw new Error("connection failed"); },
    });
    const ctrl = new PlatformController(makeRefs({ telegram }));

    const result = await ctrl.handle("telegram", "start");

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "connection failed" });
  });

  it("returns 500 when discord stop throws", async () => {
    const discord = mockPoller({
      stopFn: () => { throw new Error("disconnect error"); },
    });
    const ctrl = new PlatformController(makeRefs({ discord }));

    const result = await ctrl.handle("discord", "stop");

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "disconnect error" });
  });

  it("returns 500 when start rejects with async error", async () => {
    const telegram = mockPoller({
      startFn: async () => { throw new Error("async failure"); },
    });
    const ctrl = new PlatformController(makeRefs({ telegram }));

    const result = await ctrl.handle("telegram", "start");

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "async failure" });
  });
});

// ── getStates ───────────────────────────────────────────────────────────────

describe("PlatformController.getStates", () => {
  it("reports both platforms as not configured when pollers are null", () => {
    const ctrl = new PlatformController(
      makeRefs({ telegram: null, discord: null }),
    );

    const states = ctrl.getStates();

    expect(states.telegram).toEqual({ configured: false, running: false });
    expect(states.discord).toEqual({ configured: false, running: false });
  });

  it("reports configured but not running before any action", () => {
    const ctrl = new PlatformController(makeRefs());

    const states = ctrl.getStates();

    expect(states.telegram).toEqual({ configured: true, running: false });
    expect(states.discord).toEqual({ configured: true, running: false });
  });

  it("reflects running state after start", async () => {
    const ctrl = new PlatformController(makeRefs());

    await ctrl.handle("telegram", "start");
    const states = ctrl.getStates();

    expect(states.telegram.running).toBe(true);
    expect(states.discord.running).toBe(false);
  });

  it("reflects stopped state after stop", async () => {
    const ctrl = new PlatformController(makeRefs());

    await ctrl.handle("telegram", "start");
    await ctrl.handle("telegram", "stop");
    const states = ctrl.getStates();

    expect(states.telegram.running).toBe(false);
  });
});

// Feature: kiro-professor-webui, Property 5: Platform toggle state consistency
import fc from "fast-check";

describe("PlatformController — Property 5: Platform toggle state consistency", () => {
  // **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 14.3**

  it("configured platform running state matches the action after handling", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          platform: fc.constantFrom("telegram", "discord"),
          action: fc.constantFrom("start", "stop"),
          configured: fc.boolean(),
        }),
        async ({ platform, action, configured }) => {
          const telegramPoller = platform === "telegram" && configured
            ? mockPoller()
            : platform === "telegram"
              ? null
              : mockPoller();
          const discordPoller = platform === "discord" && configured
            ? mockPoller()
            : platform === "discord"
              ? null
              : mockPoller();

          const refs = makeRefs({
            telegram: telegramPoller,
            discord: discordPoller,
          });
          const ctrl = new PlatformController(refs);

          const result = await ctrl.handle(platform, action);

          if (!configured) {
            // Unconfigured platform → 409
            expect(result.status).toBe(409);
            expect(result.body).toHaveProperty("error");
          } else {
            // Configured platform → 200, running state matches action
            expect(result.status).toBe(200);
            const expectedRunning = action === "start";
            expect(result.body).toEqual({
              platform,
              running: expectedRunning,
            });

            // getStates should also reflect the action
            const states = ctrl.getStates();
            const platformState = platform === "telegram"
              ? states.telegram
              : states.discord;
            expect(platformState.configured).toBe(true);
            expect(platformState.running).toBe(expectedRunning);
          }
        },
      ),
    );
  });

  it("returns 500 when a configured platform operation throws", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          platform: fc.constantFrom("telegram", "discord"),
          action: fc.constantFrom("start", "stop"),
          errorMsg: fc.string({ minLength: 1 }),
        }),
        async ({ platform, action, errorMsg }) => {
          const throwingPoller = mockPoller({
            startFn: () => { throw new Error(errorMsg); },
            stopFn: () => { throw new Error(errorMsg); },
          });

          const refs = makeRefs({
            telegram: platform === "telegram" ? throwingPoller : mockPoller(),
            discord: platform === "discord" ? throwingPoller : mockPoller(),
          });
          const ctrl = new PlatformController(refs);

          const result = await ctrl.handle(platform, action);

          expect(result.status).toBe(500);
          expect(result.body).toEqual({ error: errorMsg });
        },
      ),
    );
  });
});
