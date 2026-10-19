import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PiConversationParams } from "./pi-conversation-identity.js";
import {
  allocatePiBinding,
  erasePiConversation,
  openPiConversation,
  type PiSessionManagerCtor,
} from "./pi-session-adapter.js";
import { recoverPiConversation } from "./pi-session-recovery.js";

function params(canonicalWorkspace: string): PiConversationParams {
  return {
    principal: "user-1",
    platform: "telegram",
    role: "worker",
    workspaceAlias: "repo-a",
    canonicalWorkspace,
    memoryScope: "abmind",
  };
}

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
  function baseShape(id: string, file: string | undefined) {
    return {
      getSessionId: () => id,
      getSessionFile: () => file,
      getSessionDir: () => (file ? join(file, "..") : ""),
      appendMessage: (message: unknown) => {
        appended.push(message);
        return `entry-${appended.length}`;
      },
    };
  }

  const manager: PiSessionManagerCtor = {
    create(_cwd: string, sessionDir?: string, options?: { id?: string }) {
      const id = options?.id ?? "minted";
      return baseShape(id, join(sessionDir ?? "", stamp(id)));
    },
    open(path: string) {
      return baseShape(readId(path) ?? "unknown", path);
    },
    findById(_cwd: string, id: string, sessionDir?: string) {
      let names: string[];
      try {
        names = readdirSync(sessionDir ?? "");
      } catch {
        return undefined;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const candidate = join(sessionDir ?? "", name);
        if (readId(candidate) === id) return candidate;
      }
      return undefined;
    },
    forkFrom(sourcePath: string, _targetCwd: string, sessionDir?: string, options?: { id?: string }) {
      const id = options?.id ?? "minted";
      if (!existsSync(sourcePath)) throw new Error("missing source");
      const file = join(sessionDir ?? "", stamp(id));
      const lines = readFileSync(sourcePath, "utf-8").split("\n").filter((line) => line.length > 0);
      writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n");
      for (const entry of lines.slice(1)) writeFileSync(file, `${entry}\n`, { flag: "a" });
      return baseShape(id, file);
    },
  };

  function flush(id: string, sessionDir: string): string {
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

describe("pi-session-recovery", () => {
  it("rebuilds a missing conversation from authorized archive, tool, task, and current input", async () => {
    const appended: unknown[] = [];
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
    const { manager } = makeManager(appended);
    const predecessor = allocatePiBinding(stateRoot, params(workspace));
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
    const request = {
      manager,
      stateRoot,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource,
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
      taskEvidence: ["durable task evidence"],
      now: () => 123,
    };

    const result = await recoverPiConversation(request);

    expect(result.status).toBe("reconstructed");
    expect(result.handle.binding.predecessorId).toBe(predecessor.conversationId);
    expect(result.archiveTotal).toBe(3);
    expect(result.currentInputAdmitted).toBe(true);
    expect(result.taskEvidenceCount).toBe(1);
    expect(result.predecessorQuarantined).toBeNull();
    expect(result.losses).toContain("branch structure");
    expect(appendedTexts(appended)).toEqual(["user:first", "assistant:second", "user:durable task evidence", "user:live"]);

    // A retry resumes the same registered successor instead of reseeding it.
    const retry = await recoverPiConversation(request);
    expect(retry.handle.binding.conversationId).toBe(result.handle.binding.conversationId);
    expect(appended).toHaveLength(4);
  });

  it("quarantines a corrupt predecessor without overwriting source data", async () => {
    const appended: unknown[] = [];
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
    const { manager, flush } = makeManager(appended);
    const predecessor = allocatePiBinding(stateRoot, params(workspace));
    openPiConversation(manager, stateRoot, predecessor);
    const file = flush(predecessor.conversationId, predecessor.sessionDir);
    openPiConversation(manager, stateRoot, predecessor);
    writeFileSync(file, "corrupt\n");

    const result = await recoverPiConversation({
      manager,
      stateRoot,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource: {
        projectArchive: async () => ({ messages: [{ role: "user" as const, content: "archived" }] }),
      },
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
      now: () => 123,
    });

    expect(result.status).toBe("reconstructed");
    expect(result.predecessorQuarantined).toBe(`${file}.quarantined`);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.quarantined`, "utf-8")).toBe("corrupt\n");
    expect(appendedTexts(appended)).toEqual(["user:archived", "user:live"]);
  });

  it("refuses to reconstruct an erased predecessor", async () => {
    const appended: unknown[] = [];
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
    const { manager, flush } = makeManager(appended);
    const predecessor = allocatePiBinding(stateRoot, params(workspace));
    openPiConversation(manager, stateRoot, predecessor);
    flush(predecessor.conversationId, predecessor.sessionDir);
    openPiConversation(manager, stateRoot, predecessor);
    erasePiConversation(stateRoot, predecessor.conversationId);

    await expect(recoverPiConversation({
      manager,
      stateRoot,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource: { projectArchive: async () => ({ messages: [] }) },
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
    })).rejects.toThrow(/erased/);
    expect(appended).toEqual([]);
  });

  it("refuses to reconstruct from an ambiguous predecessor", async () => {
    const appended: unknown[] = [];
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-recovery-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-recovery-ws-"));
    const { manager, flush } = makeManager(appended);
    const predecessor = allocatePiBinding(stateRoot, params(workspace));
    openPiConversation(manager, stateRoot, predecessor);
    flush(predecessor.conversationId, predecessor.sessionDir);
    writeFileSync(
      join(predecessor.sessionDir, `2026-02-02T00-00-00-000Z_${predecessor.conversationId}.jsonl`),
      `${JSON.stringify({ type: "session", id: predecessor.conversationId })}\n`,
    );

    await expect(recoverPiConversation({
      manager,
      stateRoot,
      predecessor,
      archive: { userId: "user-1", archiveSessionId: "archive-1", beforeMessageId: 7, maxContext: 1000 },
      archiveSource: { projectArchive: async () => ({ messages: [] }) },
      current: { text: "live", timestamp: 123, operationKey: "op-live" },
    })).rejects.toThrow(/ambiguous/);
    expect(appended).toEqual([]);
  });
});
