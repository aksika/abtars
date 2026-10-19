import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocatePiSuccessor,
  canonicalWorkspaceKey,
  isValidPiConversationId,
  mintPiConversationId,
  opaquePrincipalKey,
  resolvePiConversationDir,
  resolvePiConversationFile,
  verifyPiConversationFile,
} from "./pi-conversation-identity.js";

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

  it("verifies exact-ID files and rejects header mismatch", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-id-"));
    const sessionDir = join(base, "partition");
    mkdirSync(sessionDir, { recursive: true });
    const id = "conv-1";
    const file = resolvePiConversationFile(sessionDir, id);
    writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n");

    const found = verifyPiConversationFile(base, sessionDir, id, () => id);
    expect(found).toEqual({ ok: true, canonicalFile: file });

    const mismatch = verifyPiConversationFile(base, sessionDir, id, () => "other");
    expect(mismatch.ok).toBe(false);

    const missing = verifyPiConversationFile(base, sessionDir, "absent-9", () => null);
    expect(missing).toEqual({ ok: false, reason: "conversation file not found" });
  });

  it("rejects files escaping the authorized partition", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-escape-"));
    const sessionDir = join(base, "partition");
    mkdirSync(sessionDir, { recursive: true });
    const escaped = verifyPiConversationFile(base, sessionDir, "..", () => "..");
    expect(escaped.ok).toBe(false);
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
});
