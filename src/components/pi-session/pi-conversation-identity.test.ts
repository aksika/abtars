import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocatePiSuccessor,
  buildOwnedSessionLaunchArgs,
  canonicalWorkspaceKey,
  isValidPiConversationId,
  mintPiConversationId,
  opaquePrincipalKey,
  resolvePiConversationDir,
  verifyPiConversationFile,
} from "./pi-conversation-identity.js";

function writeHeader(file: string, id: string): void {
  writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n");
}

describe("pi-conversation-identity", () => {
  it("mints Pi-valid unique IDs", () => {
    const first = mintPiConversationId();
    const second = mintPiConversationId();
    expect(isValidPiConversationId(first)).toBe(true);
    expect(isValidPiConversationId(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("rejects IDs Pi would reject", () => {
    expect(isValidPiConversationId("")).toBe(false);
    expect(isValidPiConversationId("-leading")).toBe(false);
    expect(isValidPiConversationId("has space")).toBe(false);
    expect(isValidPiConversationId("ok-id_1.2")).toBe(true);
  });

  it("partitions by opaque principal, role, and workspace without raw PII", () => {
    const dir = resolvePiConversationDir("/root", "user@example.com", "worker", "/repo/a");
    expect(dir).toContain(join("/root", opaquePrincipalKey("user@example.com"), "worker"));
    expect(dir).toContain(canonicalWorkspaceKey("/repo/a"));
    expect(dir).not.toContain("user@example.com");
    expect(dir).not.toContain("/repo/a");
  });

  it("verifies discovered files and rejects header mismatch", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-id-"));
    const sessionDir = join(base, "partition");
    mkdirSync(sessionDir, { recursive: true });
    const id = "conv-1";
    const file = join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    writeHeader(file, id);

    const found = verifyPiConversationFile(base, sessionDir, id, file, (candidate) =>
      candidate === file ? id : null,
    );
    expect(found).toEqual({ ok: true, canonicalFile: file });

    const mismatch = verifyPiConversationFile(base, sessionDir, id, file, () => "other");
    expect(mismatch).toEqual({ ok: false, reason: "header id does not match conversation id" });
  });

  it("rejects files escaping the authorized partition", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-id-"));
    const sessionDir = join(base, "partition");
    mkdirSync(sessionDir, { recursive: true });
    const escaped = verifyPiConversationFile(base, sessionDir, "conv-1", join(base, "..", "evil.jsonl"), () => "conv-1");
    expect(escaped.ok).toBe(false);
  });

  it("rejects a symlinked candidate that resolves outside the partition", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-id-"));
    const sessionDir = join(base, "partition");
    mkdirSync(sessionDir, { recursive: true });
    const outside = join(base, "outside.jsonl");
    writeHeader(outside, "conv-1");
    const link = join(sessionDir, "2026-01-01T00-00-00-000Z_conv-1.jsonl");
    symlinkSync(outside, link);

    const result = verifyPiConversationFile(base, sessionDir, "conv-1", link, () => "conv-1");
    expect(result).toEqual({ ok: false, reason: "conversation file is a symlink" });
  });

  it("allocates a fresh successor with predecessor lineage", () => {
    const predecessor = {
      conversationId: "conv-a",
      principal: "u1",
      platform: "telegram",
      role: "worker" as const,
      workspaceAlias: "repo-a",
      canonicalWorkspace: "/repo/a",
      memoryScope: "abmind" as const,
      sessionDir: "/root/u1/worker/ws",
    };
    const next = allocatePiSuccessor(predecessor);
    expect(next.conversationId).not.toBe("conv-a");
    expect(isValidPiConversationId(next.conversationId)).toBe(true);
    expect(next.predecessorId).toBe("conv-a");
    expect(next.sessionDir).toBe(predecessor.sessionDir);
  });

  it("builds the owned RPC launch vector: partitioned dir plus exact conversation ID", () => {
    const built = buildOwnedSessionLaunchArgs("/root", {
      principal: "user@example.com",
      role: "worker",
      canonicalWorkspace: "/repo/a",
      conversationId: "conv-1",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.sessionDir).toBe(
      resolvePiConversationDir("/root", "user@example.com", "worker", "/repo/a"),
    );
    expect(built.args).toEqual(["--session-dir", built.sessionDir, "--session-id", "conv-1"]);
  });

  it("refuses an owned launch with an invalid conversation ID", () => {
    const built = buildOwnedSessionLaunchArgs("/root", {
      principal: "u1",
      role: "worker",
      canonicalWorkspace: "/repo/a",
      conversationId: "has space",
    });
    expect(built).toEqual({ ok: false, reason: "owned session launch requires a valid conversation id" });
  });

  it("refuses an owned launch missing principal or workspace", () => {
    const built = buildOwnedSessionLaunchArgs("/root", {
      principal: "",
      role: "worker",
      canonicalWorkspace: "/repo/a",
      conversationId: "conv-1",
    });
    expect(built.ok).toBe(false);
  });
});
