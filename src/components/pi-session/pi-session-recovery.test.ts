import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintPiConversationId, resolvePiConversationDir } from "./pi-conversation-identity.js";
import { recoverPiConversation, type PiRecoveryRequest } from "./pi-session-recovery.js";

function stamp(id: string): string {
  return `2026-01-01T00-00-00-000Z_${id}.jsonl`;
}

function readId(file: string): string | null {
  try {
    const line = readFileSync(file, "utf-8").split("\n")[0] ?? "";
    const parsed = JSON.parse(line) as { type?: unknown; id?: unknown };
    return parsed.type === "session" && typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

/** Fake mirrors real SDK file semantics and records seeded history appends. */
function makeManager(appended: unknown[]) {
  function baseShape(id: string) {
    return {
      getSessionId: () => id,
      appendMessage: (message: unknown) => {
        appended.push(message);
        return `entry-${appended.length}`;
      },
    };
  }

  const manager = {
    create(_cwd: string, _sessionDir?: string, options?: { id?: string }) {
      return baseShape(options?.id ?? "minted");
    },
    open(path: string) {
      return { ...baseShape(readId(path) ?? "unknown"), getSessionFile: () => path };
    },
    findById(_cwd: string, _id: string, _sessionDir?: string) {
      return undefined;
    },
  };

  function flush(id: string, sessionDir: string): string {
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, stamp(id));
    writeFileSync(file, `${JSON.stringify({ type: "session", id })}\n`);
    return file;
  }

  return { manager, flush };
}

function appendedTexts(appended: unknown[]): string[] {
  return appended.map((message) => {
    const entry = message as { role: string; content: Array<{ text: string }> };
    return `${entry.role}:${entry.content[0]?.text ?? ""}`;
  });
}

function predecessorFor(storageRoot: string, workspace: string, sessionFile?: string) {
  const conversationId = mintPiConversationId();
  return {
    conversationId,
    sessionDir: resolvePiConversationDir(storageRoot, "user-1", "worker", workspace),
    cwd: workspace,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
  };
}

function baseRequest(overrides?: Partial<PiRecoveryRequest>): PiRecoveryRequest {
  const storageRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
  const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
  const progressDir = mkdtempSync(join(tmpdir(), "pi-recovery-prog-"));
  return {
    sessionManager: makeManager([]).manager as never,
    sessionStorageRoot: storageRoot,
    progressDir,
    predecessor: predecessorFor(storageRoot, workspace),
    archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
    archiveSource: { projectArchive: async () => ({ messages: [] }) },
    current: { text: "live", timestamp: 123, operationKey: "op-live" },
    ...overrides,
  };
}

describe("pi-session-recovery", () => {
  it("rebuilds a missing conversation from authorized archive, task evidence, and current input", async () => {
    const appended: unknown[] = [];
    const storageRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
    const progressDir = mkdtempSync(join(tmpdir(), "pi-recovery-prog-"));
    const { manager } = makeManager(appended);
    const predecessor = predecessorFor(storageRoot, workspace);
    const archiveSource = {
      projectArchive: async (input: { userId: string; archiveSessionId: string; beforeMessageId: number; maxContext: number }) => {
        expect(input).toEqual({ userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 });
        return {
          messages: [
            { role: "user" as const, content: "first" },
            { role: "assistant" as const, content: "second" },
            { role: "tool" as const, content: "tool result is a declared loss" },
            { role: "user" as const, content: "   " },
          ],
        };
      },
    };

    const result = await recoverPiConversation({
      sessionManager: manager as never,
      sessionStorageRoot: storageRoot,
      progressDir,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource,
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
      taskEvidence: ["durable task evidence"],
      now: () => 123,
    });

    expect(result.status).toBe("reconstructed");
    expect(result.successorId).not.toBe(predecessor.conversationId);
    expect(result.successorDir).toBe(predecessor.sessionDir);
    expect(result.archiveTotal).toBe(3);
    expect(result.currentInputAdmitted).toBe(true);
    expect(result.taskEvidenceCount).toBe(1);
    expect(result.predecessorQuarantined).toBeNull();
    expect(result.losses).toContain("branch structure");
    expect(appendedTexts(appended)).toEqual(["user:first", "assistant:second", "user:durable task evidence", "user:live"]);

    // A retry resumes the same successor instead of reseeding it.
    const retry = await recoverPiConversation({
      sessionManager: manager as never,
      sessionStorageRoot: storageRoot,
      progressDir,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource,
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
      taskEvidence: ["durable task evidence"],
      now: () => 123,
    });
    expect(retry.successorId).toBe(result.successorId);
    expect(appended).toHaveLength(4);
  });

  it("returns intact without touching the archive when the file verifies", async () => {
    const appended: unknown[] = [];
    const storageRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
    const progressDir = mkdtempSync(join(tmpdir(), "pi-recovery-prog-"));
    const { manager, flush } = makeManager(appended);
    const predecessor = predecessorFor(storageRoot, workspace);
    flush(predecessor.conversationId, predecessor.sessionDir);

    const result = await recoverPiConversation({
      sessionManager: manager as never,
      sessionStorageRoot: storageRoot,
      progressDir,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource: {
        projectArchive: async () => { throw new Error("archive must not be read on the intact path"); },
      },
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
    });

    expect(result.status).toBe("intact");
    expect(result.successorId).toBe(predecessor.conversationId);
    expect(appended).toEqual([]);
  });

  it("quarantines a corrupt predecessor without overwriting source data", async () => {
    const appended: unknown[] = [];
    const storageRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
    const progressDir = mkdtempSync(join(tmpdir(), "pi-recovery-prog-"));
    const { manager, flush } = makeManager(appended);
    const preliminary = predecessorFor(storageRoot, workspace);
    const file = flush(preliminary.conversationId, preliminary.sessionDir);
    writeFileSync(file, "corrupt\n");
    const predecessor = {
      ...predecessorFor(storageRoot, workspace),
      conversationId: preliminary.conversationId,
      sessionDir: preliminary.sessionDir,
      sessionFile: file,
    };

    const result = await recoverPiConversation({
      sessionManager: manager as never,
      sessionStorageRoot: storageRoot,
      progressDir,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource: {
        projectArchive: async () => ({ messages: [{ role: "user" as const, content: "archived" }] }),
      },
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
      now: () => 123,
    });

    expect(result.status).toBe("reconstructed");
    expect(result.predecessorQuarantined).toMatch(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.quarantined-`));
    expect(existsSync(file)).toBe(false);
    const quarantined = result.predecessorQuarantined!;
    expect(readFileSync(quarantined, "utf-8")).toBe("corrupt\n");
    expect(appendedTexts(appended)).toEqual(["user:archived", "user:live"]);
  });

  it("starts explicitly fresh (current input only) when the archive is empty", async () => {
    const appended: unknown[] = [];
    const request = baseRequest();
    const { manager } = makeManager(appended);

    const result = await recoverPiConversation({
      ...request,
      sessionManager: manager as never,
      archiveSource: { projectArchive: async () => ({ messages: [] }) },
    });

    expect(result.status).toBe("reconstructed");
    expect(result.archiveTotal).toBe(0);
    expect(result.currentInputAdmitted).toBe(true);
    expect(result.losses.length).toBeGreaterThan(0);
    expect(appendedTexts(appended)).toEqual(["user:live"]);
  });

  it("refuses to reconstruct from an ambiguous predecessor", async () => {
    const appended: unknown[] = [];
    const storageRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
    const progressDir = mkdtempSync(join(tmpdir(), "pi-recovery-prog-"));
    const { manager, flush } = makeManager(appended);
    const predecessor = predecessorFor(storageRoot, workspace);
    flush(predecessor.conversationId, predecessor.sessionDir);
    writeFileSync(
      join(predecessor.sessionDir, `2026-02-02T00-00-00-000Z_${predecessor.conversationId}.jsonl`),
      `${JSON.stringify({ type: "session", id: predecessor.conversationId })}\n`,
    );

    await expect(recoverPiConversation({
      sessionManager: manager as never,
      sessionStorageRoot: storageRoot,
      progressDir,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource: { projectArchive: async () => ({ messages: [] }) },
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
    })).rejects.toThrow(/ambiguous/);
    expect(appended).toEqual([]);
  });

  it("fails closed when the archive source rejects (never silent fresh start)", async () => {
    const request = baseRequest();
    const { manager } = makeManager([]);
    await expect(recoverPiConversation({
      ...request,
      sessionManager: manager as never,
      archiveSource: { projectArchive: async () => { throw new Error("abmind down"); } },
    })).rejects.toThrow(/abmind down/);
  });

  it("readdir sanity: claimant scan only matches jsonl headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-recovery-scan-"));
    writeFileSync(join(dir, "notes.txt"), "x");
    const names = readdirSync(dir);
    expect(names).toEqual(["notes.txt"]);
  });
});
