import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOwnedSessionLaunchArgs,
  canonicalWorkspaceKey,
  isValidPiConversationId,
  mintPiConversationId,
  opaquePrincipalKey,
  resolvePiConversationDir,
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
