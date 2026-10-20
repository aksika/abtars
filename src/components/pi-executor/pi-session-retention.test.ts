/**
 * pi-session-retention.test.ts — #1932 R8 production retention wiring.
 *
 * Proves the boot sweep prunes only aged files of terminal sessions with a
 * proven identity and no live writer, drops only dead-weight bindings,
 * removes only aged quarantine, and that explicit erasure removes owned
 * files without touching anything else.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENDED_RETENTION_MS,
  eraseCodingSessionFiles,
  removeProvenSessionFile,
  sweepPiSessionsAtBoot,
  sweepQuarantineFiles,
  sweepRpcSessionFiles,
} from "./pi-session-retention.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-retention-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSession(dir: string, file: string, id: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ type: "session", id }) + "\n", "utf-8");
  return path;
}

function ageFile(path: string, ms: number): void {
  const past = new Date(Date.now() - ms);
  utimesSync(path, past, past);
}

describe("removeProvenSessionFile", () => {
  it("removes a proven file", () => {
    const file = writeSession(root, "2026-01-01T00-00-00-000Z_sess-1.jsonl", "sess-1");
    expect(removeProvenSessionFile(root, "sess-1", file)).toBe(true);
  });

  it("keeps a file whose header does not match the expected id", () => {
    const file = writeSession(root, "2026-01-01T00-00-00-000Z_sess-1.jsonl", "sess-1");
    expect(removeProvenSessionFile(root, "other-id", file)).toBe(false);
  });

  it("keeps a missing file without throwing", () => {
    expect(removeProvenSessionFile(root, "sess-1", join(root, "gone.jsonl"))).toBe(false);
  });

  it("refuses a symlink even when it resolves inside the root", () => {
    const target = writeSession(root, "real.jsonl", "sess-1");
    const link = join(root, "2026-01-01T00-00-00-000Z_sess-1.jsonl");
    symlinkSync(target, link);
    expect(removeProvenSessionFile(root, "sess-1", link)).toBe(false);
  });

  it("refuses empty identity without throwing", () => {
    const file = writeSession(root, "2026-01-01T00-00-00-000Z_sess-1.jsonl", "sess-1");
    expect(removeProvenSessionFile(root, undefined, file)).toBe(false);
    expect(removeProvenSessionFile(root, "sess-1", undefined)).toBe(false);
  });
});

describe("sweepRpcSessionFiles", () => {
  it("prunes aged files of terminal sessions and keeps everything else", () => {
    const oldFile = writeSession(root, "old.jsonl", "old-1");
    ageFile(oldFile, ENDED_RETENTION_MS + 1_000);
    const freshFile = writeSession(root, "fresh.jsonl", "fresh-1");
    const liveFile = writeSession(root, "live.jsonl", "live-1");
    ageFile(liveFile, ENDED_RETENTION_MS + 1_000);
    const activeFile = writeSession(root, "active.jsonl", "active-1");
    ageFile(activeFile, ENDED_RETENTION_MS + 1_000);

    const report = sweepRpcSessionFiles(root, [
      { kind: "coding", sessionId: "c-old", piSessionId: "old-1", piSessionFile: oldFile, terminal: true },
      { kind: "coding", sessionId: "c-fresh", piSessionId: "fresh-1", piSessionFile: freshFile, terminal: true },
      { kind: "supervised", sessionId: "r-live", piSessionId: "live-1", piSessionFile: liveFile, observedPid: process.pid, terminal: true },
      { kind: "coding", sessionId: "c-active", piSessionId: "active-1", piSessionFile: activeFile, terminal: false },
      { kind: "coding", sessionId: "c-nofile", terminal: true },
    ], Date.now());

    expect(report.removed).toEqual(["c-old"]);
    expect(report.kept.sort()).toEqual(["c-active", "c-fresh", "r-live", "c-nofile"].sort());
  });
});

describe("eraseCodingSessionFiles", () => {
  it("removes the row's proven file and reports it", () => {
    const file = writeSession(root, "2026-01-01T00-00-00-000Z_sess-9.jsonl", "sess-9");
    const removed = eraseCodingSessionFiles({ sessionStorageRoot: root, piSessionId: "sess-9", piSessionFile: file });
    expect(removed).toEqual([file]);
  });

  it("removes quarantine siblings carrying the same session ID", () => {
    const file = writeSession(root, "2026-01-01T00-00-00-000Z_sess-9.jsonl", "sess-9");
    const quarantined = `${file}.quarantined-123`;
    writeFileSync(quarantined, "quarantined transcript\n");
    const removed = eraseCodingSessionFiles({ sessionStorageRoot: root, piSessionId: "sess-9", piSessionFile: file });
    expect(removed.sort()).toEqual([file, quarantined].sort());
  });

  it("returns empty when nothing is removable", () => {
    expect(eraseCodingSessionFiles({ sessionStorageRoot: root, piSessionId: "gone", piSessionFile: join(root, "gone.jsonl") })).toEqual([]);
    expect(eraseCodingSessionFiles({ sessionStorageRoot: root })).toEqual([]);
  });
});

describe("sweepQuarantineFiles", () => {
  it("removes only aged quarantine files, never live transcripts or symlinks", () => {
    const part = join(root, "abc", "main", "def");
    const oldQ = join(part, "2026-01-01T00-00-00-000Z_sess-1.jsonl.quarantined-1");
    writeSession(part, "2026-01-01T00-00-00-000Z_sess-1.jsonl.quarantined-1", "sess-1");
    ageFile(oldQ, ENDED_RETENTION_MS + 1_000);
    const freshQ = join(part, "2026-02-02T00-00-00-000Z_sess-2.jsonl.quarantined-2");
    writeSession(part, "2026-02-02T00-00-00-000Z_sess-2.jsonl.quarantined-2", "sess-2");
    const live = writeSession(part, "2026-03-03T00-00-00-000Z_sess-3.jsonl", "sess-3");

    const removed = sweepQuarantineFiles(root, Date.now());
    expect(removed).toEqual([oldQ]);
    expect(freshQ && live).toBeTruthy();
  });
});

describe("sweepPiSessionsAtBoot", () => {
  it("prunes terminal rows and never throws on store failures", () => {
    const oldFile = writeSession(root, "boot-old.jsonl", "boot-old-1");
    ageFile(oldFile, ENDED_RETENTION_MS + 1_000);
    const codingStore = {
      listSessionFiles: () => [
        { sessionId: "c-old", state: "ended", piSessionId: "boot-old-1", piSessionFile: oldFile },
        { sessionId: "c-live", state: "running", piSessionId: "boot-live-1", piSessionFile: undefined },
      ],
    };
    const runStore = {
      list: (filter?: { status?: string }) => filter?.status === "completed"
        ? [{ id: "r-done", status: "completed", piSessionId: undefined, piSessionFile: undefined }]
        : [],
    };
    const report = sweepPiSessionsAtBoot({
      sessionStorageRoot: root,
      codingStore: codingStore as never,
      runStore: runStore as never,
    });
    expect(report.rpcRemoved).toEqual(["c-old"]);
    // Non-terminal rows never enter the sweep; the file-less terminal row
    // is evaluated and kept.
    expect(report.rpcKept).toContain("r-done");
    expect(report.quarantineRemoved).toEqual([]);
  });

  it("returns empty reports when both stores fail", () => {
    const codingStore = {
      listSessionFiles: () => { throw new Error("db locked"); },
    };
    const runStore = {
      list: () => { throw new Error("db locked"); },
    };
    const report = sweepPiSessionsAtBoot({
      sessionStorageRoot: root,
      codingStore: codingStore as never,
      runStore: runStore as never,
    });
    expect(report).toEqual({ rpcRemoved: [], rpcKept: [], quarantineRemoved: [] });
  });
});
