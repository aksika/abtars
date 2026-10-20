/**
 * pi-owned-files.test.ts — #1932: owned-file inspection, quarantine, and
 * reseed progress bounds.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findOwnedClaimants,
  inspectOwnedConversationFile,
  loadPiReseedProgress,
  quarantineOwnedConversationFile,
  readPiSessionHeaderId,
  savePiReseedProgress,
  seedWriterForSessionManager,
} from "./pi-owned-files.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-owned-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSession(dir: string, file: string, id: string, body = ""): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ type: "session", id }) + "\n" + body, "utf-8");
  return path;
}

describe("inspectOwnedConversationFile", () => {
  it("reports intact for a verified claimant", () => {
    const dir = join(root, "p");
    const file = writeSession(dir, "2026-01-01T00-00-00-000Z_abc.jsonl", "abc");
    expect(inspectOwnedConversationFile(root, dir, "abc")).toEqual({ status: "intact", canonicalFile: file });
  });

  it("reports missing when nothing claims the ID", () => {
    const dir = join(root, "p");
    mkdirSync(dir, { recursive: true });
    expect(inspectOwnedConversationFile(root, dir, "abc")).toEqual({ status: "missing", canonicalFile: null });
  });

  it("reports ambiguous on duplicate claimants", () => {
    const dir = join(root, "p");
    writeSession(dir, "2026-01-01T00-00-00-000Z_abc.jsonl", "abc");
    writeSession(dir, "2026-02-02T00-00-00-000Z_abc.jsonl", "abc");
    const inspection = inspectOwnedConversationFile(root, dir, "abc");
    expect(inspection.status).toBe("ambiguous");
  });

  it("reports corrupt from a known file whose header no longer matches", () => {
    const dir = join(root, "p");
    const file = writeSession(dir, "2026-01-01T00-00-00-000Z_abc.jsonl", "abc");
    writeFileSync(file, "corrupt\n");
    const inspection = inspectOwnedConversationFile(root, dir, "abc", file);
    expect(inspection.status).toBe("corrupt");
    expect(inspection.canonicalFile).toBe(file);
  });

  it("rejects invalid IDs without touching the filesystem", () => {
    expect(inspectOwnedConversationFile(root, join(root, "p"), "../evil")).toEqual({
      status: "corrupt",
      canonicalFile: null,
      reason: "invalid conversation id",
    });
  });
});

describe("quarantineOwnedConversationFile", () => {
  it("renames a corrupt file beside its partition path", () => {
    const dir = join(root, "p");
    const file = writeSession(dir, "f.jsonl", "abc");
    writeFileSync(file, "corrupt\n");
    const quarantined = quarantineOwnedConversationFile(root, file);
    expect(quarantined.startsWith(`${file}.quarantined-`)).toBe(true);
  });

  it("refuses files outside the root and symlinks", () => {
    expect(() => quarantineOwnedConversationFile(root, "/etc/hostname")).toThrow(/outside the authorized root/);
    const dir = join(root, "p");
    const target = writeSession(dir, "real.jsonl", "abc");
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);
    expect(() => quarantineOwnedConversationFile(root, link)).toThrow(/non-regular/);
  });
});

describe("seedWriterForSessionManager", () => {
  it("appends ordinary user/assistant turns with declared synthetic identity", () => {
    const appended: unknown[] = [];
    const writer = seedWriterForSessionManager({
      appendMessage: (message) => {
        appended.push(message);
        return "e1";
      },
    });
    writer.appendSeed({ role: "user", text: "u", timestamp: 1 });
    writer.appendSeed({ role: "assistant", text: "a", timestamp: 2 });
    expect(appended).toHaveLength(2);
    const assistant = appended[1] as { provider?: string; model?: string; usage?: { input?: number } };
    expect(assistant.provider).toBe("abmind");
    expect(assistant.model).toBe("historical");
    expect(assistant.usage?.input).toBe(0);
  });
});

describe("reseed progress", () => {
  it("round-trips progress and restarts on corrupt data", () => {
    const dir = join(root, "progress");
    expect(loadPiReseedProgress(dir, "c1")).toEqual({ seeded: 0, currentAdmitted: false });
    savePiReseedProgress(dir, "c1", { seeded: 3, currentAdmitted: true, successorId: "s1" });
    expect(loadPiReseedProgress(dir, "c1")).toEqual({ seeded: 3, currentAdmitted: true, successorId: "s1" });
    writeFileSync(join(dir, "c1.reseed.json"), "corrupt\n");
    expect(loadPiReseedProgress(dir, "c1")).toEqual({ seeded: 0, currentAdmitted: false });
  });

  it("reads headers bounded (first line only)", () => {
    const dir = join(root, "p");
    const file = writeSession(dir, "f.jsonl", "abc", "x".repeat(100000));
    expect(readPiSessionHeaderId(file)).toBe("abc");
    expect(findOwnedClaimants(dir, "abc")).toEqual([file]);
    expect(findOwnedClaimants(dir, "other")).toEqual([]);
  });
});
