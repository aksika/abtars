import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "channel-test-"));
}

describe("kanban-channel (#949)", () => {
  const CARD = 999;
  let channel: typeof import("./kanban-channel.js");
  let nerve: typeof import("../nerve.js").nerve;

  beforeAll(async () => {
    vi.resetModules();
    tmp = freshHome();
    process.env["ABTARS_HOME"] = tmp;
    channel = await import("./kanban-channel.js");
    nerve = (await import("../nerve.js")).nerve;
    // Seed a few messages
    channel.channelPost(CARD, "worker-01", "ALL", "started task");
    channel.channelPost(CARD, "worker-01", "ALL", "progress 50%", false, "progress");
    channel.channelPost(CARD, "worker-01", "ALL", "need help", false, "question");
  });

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("channelPost stores msg_type", () => {
    const msgs = channel.channelRead(CARD);
    expect(msgs[2]!.msg_type).toBe("question");
    expect(msgs[1]!.msg_type).toBe("progress");
    expect(msgs[0]!.source_ref).toBeNull();
  });

  it("channelPostFromRemote inserts with remote_peer", () => {
    const ts = "2026-06-19 12:00:00";
    const ok = channel.channelPostFromRemote(CARD, "remote-w", "hello from molty", ts, "molty");
    expect(ok).toBe(true);
    const msgs = channel.channelRead(CARD);
    const remote = msgs.find(m => m.from_agent === "remote-w");
    expect(remote).toBeDefined();
    expect(remote!.remote_peer).toBe("molty");
  });

  it("channelPostFromRemote deduplicates same (card, from, created_at)", () => {
    const ts = "2026-06-19 12:00:01";
    channel.channelPostFromRemote(CARD, "remote-w", "first", ts, "molty");
    const ok = channel.channelPostFromRemote(CARD, "remote-w", "duplicate", ts, "molty");
    // INSERT OR IGNORE — silently skipped
    expect(ok).toBe(true); // no throw
    const msgs = channel.channelRead(CARD).filter(m => m.created_at === ts);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.message).toBe("first");
  });

  it("channelGetSince returns only messages after timestamp", () => {
    const ts = "2026-06-19 11:59:59";
    const msgs = channel.channelGetSince(CARD, ts);
    // Should include the remote messages posted at 12:00:00 and 12:00:01
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs.every(m => m.created_at > ts)).toBe(true);
  });

  it("channelGetSince with future timestamp returns empty", () => {
    const msgs = channel.channelGetSince(CARD, "2099-01-01 00:00:00");
    expect(msgs.length).toBe(0);
  });
});

describe("kanban-channel source_ref once-posting (#1643)", () => {
  let channel: typeof import("./kanban-channel.js");
  let nerve: typeof import("../nerve.js").nerve;
  let cardId: number;

  beforeAll(async () => {
    vi.resetModules();
    tmp = freshHome();
    process.env["ABTARS_HOME"] = tmp;
    channel = await import("./kanban-channel.js");
    nerve = (await import("../nerve.js")).nerve;
    cardId = 1643;
  });

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("posts once by sourceRef with a round-trip source_ref and fires exactly one Nerve event", () => {
    const fire = vi.spyOn(nerve, "fire");
    const first = channel.channelPostOnce({
      cardId, from: "Worker:901", to: "Orc",
      message: "Found the root cause.", directive: false, msgType: "progress",
      sourceRef: "pi-orc:v1:run-1:1:tc-1",
    });
    expect(first).toBe("posted");
    const second = channel.channelPostOnce({
      cardId, from: "Worker:901", to: "Orc",
      message: "Found the root cause (replayed frame).", directive: false, msgType: "progress",
      sourceRef: "pi-orc:v1:run-1:1:tc-1",
    });
    expect(second).toBe("duplicate");
    const rows = channel.channelRead(cardId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_ref).toBe("pi-orc:v1:run-1:1:tc-1");
    expect(rows[0]!.message).toBe("Found the root cause.");
    const channelEvents = fire.mock.calls.filter(call => call[0] === "channel:message");
    expect(channelEvents).toHaveLength(1);
    fire.mockRestore();
  });

  it("ordinary null-source posts still duplicate normally and stay non-deduped", () => {
    channel.channelPost(cardId, "Worker:901", "Orc", "plain one");
    channel.channelPost(cardId, "Worker:901", "Orc", "plain two");
    const plain = channel.channelRead(cardId).filter(m => m.source_ref === null);
    expect(plain).toHaveLength(2);
  });

  it("migration statements replay safely on a second boot against the same DB file", async () => {
    // First boot already created the schema and used the once-path above.
    vi.resetModules();
    const reloaded = await import("./kanban-channel.js");
    // Re-boot must not throw and the same rows remain readable with the
    // source_ref column intact.
    const rows = reloaded.channelRead(cardId);
    const once = rows.find(m => m.source_ref === "pi-orc:v1:run-1:1:tc-1");
    expect(once).toBeDefined();
    // A NEW source ref still dedupes after the replay.
    const r1 = reloaded.channelPostOnce({
      cardId, from: "Worker:901", to: "Orc", message: "after replay",
      sourceRef: "pi-orc:v1:run-1:1:tc-2",
    });
    expect(r1).toBe("posted");
    const r2 = reloaded.channelPostOnce({
      cardId, from: "Worker:901", to: "Orc", message: "after replay dup",
      sourceRef: "pi-orc:v1:run-1:1:tc-2",
    });
    expect(r2).toBe("duplicate");
  });

  it("rejects a trimmed-empty message and an empty sourceRef without a row", () => {
    const empty = channel.channelPostOnce({
      cardId, from: "Worker:901", to: "Orc", message: "   ",
      sourceRef: "pi-orc:v1:run-1:1:tc-empty",
    });
    expect(empty).toBe("duplicate");
    const noRef = channel.channelPostOnce({
      cardId, from: "Worker:901", to: "Orc", message: "no ref",
      sourceRef: "",
    });
    expect(noRef).toBe("duplicate");
    const rows = channel.channelRead(cardId);
    expect(rows.some(m => m.message === "no ref")).toBe(false);
  });

  it("bounds an over-length message to the shared 1000-char contract", () => {
    const long = "x".repeat(1500);
    const result = channel.channelPostOnce({
      cardId, from: "Worker:901", to: "Orc", message: long,
      sourceRef: "pi-orc:v1:run-1:1:tc-long",
    });
    expect(result).toBe("posted");
    const rows = channel.channelRead(cardId).filter(m => m.source_ref === "pi-orc:v1:run-1:1:tc-long");
    expect(rows[0]!.message.length).toBeLessThanOrEqual(1001);
  });
});
