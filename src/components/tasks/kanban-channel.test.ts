import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point abtarsHome to tmp so tests don't touch real DB
const tmp = mkdtempSync(join(tmpdir(), "channel-test-"));
process.env["ABTARS_HOME"] = tmp;

const { channelPost, channelPostFromRemote, channelGetSince, channelRead } = await import("./kanban-channel.js");

describe("kanban-channel (#949)", () => {
  const CARD = 999;

  beforeAll(() => {
    // Seed a few messages
    channelPost(CARD, "worker-01", "ALL", "started task");
    channelPost(CARD, "worker-01", "ALL", "progress 50%", false, "progress");
    channelPost(CARD, "worker-01", "ALL", "need help", false, "question");
  });

  it("channelPost stores msg_type", () => {
    const msgs = channelRead(CARD);
    expect(msgs[2]!.msg_type).toBe("question");
    expect(msgs[1]!.msg_type).toBe("progress");
  });

  it("channelPostFromRemote inserts with remote_peer", () => {
    const ts = "2026-06-19 12:00:00";
    const ok = channelPostFromRemote(CARD, "remote-w", "hello from molty", ts, "molty");
    expect(ok).toBe(true);
    const msgs = channelRead(CARD);
    const remote = msgs.find(m => m.from_agent === "remote-w");
    expect(remote).toBeDefined();
    expect(remote!.remote_peer).toBe("molty");
  });

  it("channelPostFromRemote deduplicates same (card, from, created_at)", () => {
    const ts = "2026-06-19 12:00:01";
    channelPostFromRemote(CARD, "remote-w", "first", ts, "molty");
    const ok = channelPostFromRemote(CARD, "remote-w", "duplicate", ts, "molty");
    // INSERT OR IGNORE — silently skipped
    expect(ok).toBe(true); // no throw
    const msgs = channelRead(CARD).filter(m => m.created_at === ts);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.message).toBe("first");
  });

  it("channelGetSince returns only messages after timestamp", () => {
    const ts = "2026-06-19 11:59:59";
    const msgs = channelGetSince(CARD, ts);
    // Should include the remote messages posted at 12:00:00 and 12:00:01
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs.every(m => m.created_at > ts)).toBe(true);
  });

  it("channelGetSince with future timestamp returns empty", () => {
    const msgs = channelGetSince(CARD, "2099-01-01 00:00:00");
    expect(msgs.length).toBe(0);
  });
});
