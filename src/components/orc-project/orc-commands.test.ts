/**
 * orc-commands.test.ts — #1707 Task 5: owner-only /orc control surface.
 * Truthful counters, explicit resets that never touch terminal history,
 * and bounded alert delivery controls. Real stores in a tmpdir; the command
 * handler runs against the same durable state the coordinator consumes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let runStoreMod: typeof import("./orc-project-run-store.js");
let alertsMod: typeof import("./orc-alerts.js");
let handleOrc: typeof import("../commands/handlers-orc.js").handleOrc;

function makeCtx(): { ctx: import("../commands/types.js").CommandContext; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    reply: async (text: string) => { replies.push(text); return undefined; },
  } as unknown as import("../commands/types.js").CommandContext;
  return { ctx, replies };
}

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-commands-"));
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  runStoreMod = await import("./orc-project-run-store.js");
  alertsMod = await import("./orc-alerts.js");
  handleOrc = (await import("../commands/handlers-orc.js")).handleOrc;
  alertsMod.clearOrcAlertMuteForTest();
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function tripCardFuse(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number): Promise<void> {
  store.db.prepare(`INSERT INTO orc_fuse_state (scope, opened_at, trip_reason) VALUES (?, ?, ?)`)
    .run(`card:${cardId}`, new Date().toISOString(), "failed_attempts:3");
}

describe("#1707 /orc operator surface", () => {
  it("status reports open fuses and truthful window counts", async () => {
    const store = new runStoreMod.OrcProjectRunStore();
    await tripCardFuse(store, 47);

    const { ctx, replies } = makeCtx();
    await handleOrc("/orc status", ctx);
    const out = replies.join("\n");
    expect(out).toContain("card:47: OPEN");
    expect(out).toContain("failed_attempts:3");
    expect(out).toMatch(/starts\/5m=\d+\/25/);
    expect(out).toMatch(/rows\/5m=\d+\/50/);
  });

  it("limits lists the configured policy values", async () => {
    const { ctx, replies } = makeCtx();
    await handleOrc("/orc limits", ctx);
    const out = replies.join("\n");
    expect(out).toContain("card: 3 failed attempts/10m");
    expect(out).toContain("card: 5 no-progress starts/5m");
    expect(out).toContain("bridge: 25 starts/5m");
    expect(out).toContain("bridge: 100 starts/1h");
    expect(out).toContain("bridge: 50 new run rows/5m");
  });

  it("reset project clears only the fuse and says so", async () => {
    const store = new runStoreMod.OrcProjectRunStore();
    // A terminal attempt row stays untouched by design.
    store.db.prepare(`INSERT INTO orc_fuse_state (scope, opened_at, trip_reason) VALUES ('card:9', ?, 'terminal_execution_attempt')`)
      .run(new Date().toISOString());

    const { ctx, replies } = makeCtx();
    await handleOrc("/orc reset project 9", ctx);
    expect(replies[0]).toContain("+ Card fuse reset for #9");

    const snap = store.getFuseSnapshot().find(f => f.scope === "card:9")!;
    expect(snap.openedAt ?? null).toBeNull();
    expect(snap.generation).toBeGreaterThan(0);
  });

  it("reset project requires a valid card id", async () => {
    const { ctx, replies } = makeCtx();
    await handleOrc("/orc reset project nope", ctx);
    expect(replies[0]).toContain("Usage:");
  });

  it("reset bridge clears the emergency fuse", async () => {
    const store = new runStoreMod.OrcProjectRunStore();
    store.db.prepare(`INSERT INTO orc_fuse_state (scope, opened_at, trip_reason) VALUES ('bridge', ?, 'bridge_starts_5m:25')`)
      .run(new Date().toISOString());

    const { ctx, replies } = makeCtx();
    await handleOrc("/orc reset bridge", ctx);
    expect(replies[0]).toContain("+ Bridge fuse reset");
    expect(store.getFuseSnapshot().find(f => f.scope === "bridge")!.openedAt ?? null).toBeNull();
  });

  it("alerts mute/test/status control delivery without touching trip state", async () => {
    const store = new runStoreMod.OrcProjectRunStore();
    await tripCardFuse(store, 5);

    const mute = makeCtx();
    await handleOrc("/orc alerts mute 5", mute.ctx);
    expect(mute.replies[0]).toContain("~ Alerts muted until");
    expect(alertsMod.orcAlertsMutedUntil()).toBeGreaterThan(Date.now());

    const status = makeCtx();
    await handleOrc("/orc alerts status", status.ctx);
    expect(status.replies[0]).toContain("muted until");

    const test = makeCtx();
    await handleOrc("/orc alerts test", test.ctx);
    expect(test.replies[0]).toContain("suppressed"); // mute is active

    // Trip recording unaffected by muting:
    expect(store.getFuseSnapshot().find(f => f.scope === "card:5")!.openedAt).toBeTruthy();
  });

  it("unknown subcommand prints usage", async () => {
    const { ctx, replies } = makeCtx();
    await handleOrc("/orc frobnicate", ctx);
    expect(replies[0]).toContain("Usage:");
  });
});
