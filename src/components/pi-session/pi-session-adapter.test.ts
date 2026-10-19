import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocatePiBinding,
  bindPiObservers,
  cancelPiConversation,
  erasePiConversation,
  forkPiConversation,
  isTerminalPiEvent,
  loadPiReseedProgress,
  mapPiEventType,
  markPiConversationEnded,
  openPiConversation,
  savePiReseedProgress,
  seedWriterForSessionManager,
  sweepPiRetention,
  type PiAgentSessionShape,
  type PiSessionManagerCtor,
  type PiSessionManagerShape,
} from "./pi-session-adapter.js";
import { allocatePiSuccessor } from "./pi-conversation-identity.js";

/**
 * Fake mirrors real SDK file semantics: create assigns
 * `<timestamp>_<id>.jsonl` without flushing until content exists;
 * fork writes immediately with history.
 */
function makeSessionManager() {
  const calls: string[] = [];

  function stamp(id: string): string {
    return `2026-01-01T00-00-00-000Z_${id}.jsonl`;
  }

  function shape(id: string, file: string | undefined): PiSessionManagerShape {
    return {
      getSessionId: () => id,
      getSessionFile: () => file,
      getSessionDir: () => (file ? join(file, "..") : ""),
    };
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

  const manager: PiSessionManagerCtor = {
    create(_cwd: string, sessionDir?: string, options?: { id?: string }) {
      const id = options?.id ?? "minted";
      calls.push(`create:${id}`);
      return shape(id, join(sessionDir ?? "", stamp(id)));
    },
    open(path: string) {
      calls.push(`open:${path}`);
      return shape(readId(path) ?? "unknown", path);
    },
    findById(_cwd: string, id: string, sessionDir?: string) {
      // Disk-honest like the real SDK: first file whose header names the id.
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
      calls.push(`fork:${id}`);
      if (!existsSync(sourcePath)) throw new Error("missing source");
      const file = join(sessionDir ?? "", stamp(id));
      const lines = readFileSync(sourcePath, "utf-8").split("\n").filter((line) => line.length > 0);
      const history = lines.slice(1);
      writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n");
      for (const entry of history) writeFileSync(file, entry + "\n", { flag: "a" });
      return shape(id, file);
    },
  };

  function flush(id: string, sessionDir: string): string {
    const file = join(sessionDir, stamp(id));
    writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n");
    return file;
  }

  return { manager, calls, flush };
}

function bindingParams(canonicalWorkspace: string) {
  return {
    principal: "user-1",
    platform: "telegram",
    role: "worker" as const,
    workspaceAlias: "repo-a",
    canonicalWorkspace,
    memoryScope: "abmind" as const,
  };
}

describe("pi-session-adapter", () => {
  it("creates with the abtars-minted ID and reports unflushed files", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager, calls } = makeSessionManager();
    const binding = allocatePiBinding(stateRoot, bindingParams(workspace));

    const handle = openPiConversation(manager, stateRoot, binding);
    expect(handle.binding.conversationId).toBe(binding.conversationId);
    expect(handle.canonicalFile).toBeNull();
    expect(calls.some((call) => call === `create:${binding.conversationId}`)).toBe(true);
  });

  it("reopens an intact flushed conversation under its existing ID", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager, calls, flush } = makeSessionManager();
    const binding = allocatePiBinding(stateRoot, bindingParams(workspace));

    openPiConversation(manager, stateRoot, binding);
    const file = flush(binding.conversationId, binding.sessionDir);
    const reopened = openPiConversation(manager, stateRoot, binding);
    expect(reopened.canonicalFile).toBe(file);
    expect(calls.filter((call) => call.startsWith("create:")).length).toBe(1);
  });

  it("rejects ambiguous duplicates instead of picking one", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager, flush } = makeSessionManager();
    const binding = allocatePiBinding(stateRoot, bindingParams(workspace));

    openPiConversation(manager, stateRoot, binding);
    flush(binding.conversationId, binding.sessionDir);
    writeFileSync(
      join(binding.sessionDir, `2026-02-02T00-00-00-000Z_${binding.conversationId}.jsonl`),
      JSON.stringify({ type: "session", id: binding.conversationId }) + "\n",
    );

    expect(() => openPiConversation(manager, stateRoot, binding)).toThrow(/ambiguous/);
  });

  it("ignores files whose headers name a different conversation", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const binding = allocatePiBinding(stateRoot, bindingParams(workspace));

    const impostor = join(binding.sessionDir, `2026-01-01T00-00-00-000Z_${binding.conversationId}.jsonl`);
    mkdirSync(binding.sessionDir, { recursive: true });
    writeFileSync(impostor, JSON.stringify({ type: "session", id: "impostor" }) + "\n");

    expect(() => openPiConversation(manager, stateRoot, binding)).toThrow(/verification/);
    expect(readFileSync(impostor, "utf-8")).toContain("impostor");
  });

  it("denies cross-principal and cross-role access to an owned conversation", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const binding = allocatePiBinding(stateRoot, bindingParams(workspace));
    openPiConversation(manager, stateRoot, binding);

    const otherPrincipal = allocatePiBinding(
      stateRoot,
      { ...bindingParams(workspace), principal: "user-2" },
    );
    const hijackPrincipal = { ...otherPrincipal, conversationId: binding.conversationId };
    expect(() => openPiConversation(manager, stateRoot, hijackPrincipal)).toThrow(/different principal, role, or workspace/);

    const otherRole = allocatePiBinding(stateRoot, { ...bindingParams(workspace), role: "main" });
    const hijackRole = { ...otherRole, conversationId: binding.conversationId };
    expect(() => openPiConversation(manager, stateRoot, hijackRole)).toThrow(/different principal, role, or workspace/);
  });

  it("denies forks that reuse an id owned by another principal", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager, flush } = makeSessionManager();
    const sourceBinding = allocatePiBinding(stateRoot, bindingParams(workspace));
    openPiConversation(manager, stateRoot, sourceBinding);
    flush(sourceBinding.conversationId, sourceBinding.sessionDir);
    const source = openPiConversation(manager, stateRoot, sourceBinding);

    const taken = allocatePiBinding(stateRoot, bindingParams(workspace));
    openPiConversation(manager, stateRoot, taken);
    const rogue = {
      ...allocatePiBinding(stateRoot, { ...bindingParams(workspace), principal: "user-2" }),
      conversationId: taken.conversationId,
      predecessorId: source.binding.conversationId,
    };
    expect(() => forkPiConversation(manager, stateRoot, source, rogue)).toThrow(/different principal, role, or workspace/);
  });

  it("forks flushed history only through a preallocated successor", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager, calls, flush } = makeSessionManager();
    const sourceBinding = allocatePiBinding(stateRoot, bindingParams(workspace));
    openPiConversation(manager, stateRoot, sourceBinding);
    const sourceFile = flush(sourceBinding.conversationId, sourceBinding.sessionDir);
    const source = openPiConversation(manager, stateRoot, sourceBinding);
    expect(source.canonicalFile).toBe(sourceFile);

    const successor = allocatePiSuccessor(sourceBinding);
    const forked = forkPiConversation(manager, stateRoot, source, successor);
    expect(forked.binding.predecessorId).toBe(sourceBinding.conversationId);
    expect(calls.some((call) => call === `fork:${successor.conversationId}`)).toBe(true);

    const rogue = allocatePiBinding(stateRoot, bindingParams(workspace));
    expect(() => forkPiConversation(manager, stateRoot, source, rogue)).toThrow(/predecessor/);
  });

  it("refuses to fork a source with no persisted history yet", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const sourceBinding = allocatePiBinding(stateRoot, bindingParams(workspace));
    const source = openPiConversation(manager, stateRoot, sourceBinding);
    expect(source.canonicalFile).toBeNull();

    const successor = allocatePiSuccessor(sourceBinding);
    expect(() => forkPiConversation(manager, stateRoot, source, successor)).toThrow(/no persisted history/);
  });

  it("cancels under a closed gate with explicit queue draining", async () => {
    const session: PiAgentSessionShape = {
      clearQueue: () => ({ steering: ["s1"], followUp: ["f1"] }),
      abort: async () => {},
      waitForIdle: async () => {},
      on: () => () => {},
    };
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const handle = openPiConversation(manager, stateRoot, allocatePiBinding(stateRoot, bindingParams(workspace)));

    const result = await cancelPiConversation(session, handle, 1000);
    expect(handle.admissionOpen).toBe(false);
    expect(result.drainedSteering).toEqual(["s1"]);
    expect(result.drainedFollowUp).toEqual(["f1"]);
    expect(result.settled).toBe(true);
  });

  it("reports unsettled instead of hanging when idle never arrives", async () => {
    const session: PiAgentSessionShape = {
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => {},
      waitForIdle: () => new Promise<void>(() => {}),
      on: () => () => {},
    };
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const handle = openPiConversation(manager, stateRoot, allocatePiBinding(stateRoot, bindingParams(workspace)));

    const result = await cancelPiConversation(session, handle, 20);
    expect(result.settled).toBe(false);
  }, 10000);

  it("maps agent_settled as terminal and agent_end as recovery", () => {
    expect(mapPiEventType("agent_settled")).toBe("terminal");
    expect(mapPiEventType("agent_end")).toBe("recovery");
    expect(isTerminalPiEvent("agent_settled")).toBe(true);
    expect(isTerminalPiEvent("agent_end")).toBe(false);
  });

  it("binds replacement observers before they run and detaches together", () => {
    const seen: string[] = [];
    const unbind = vi.fn();
    const session: PiAgentSessionShape = {
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => {},
      waitForIdle: async () => {},
      on: (event: string, handler: (event: { type: string }) => void) => {
        seen.push(event);
        handler({ type: event });
        return unbind;
      },
    };
    const received: string[] = [];
    const detach = bindPiObservers(session, (type) => received.push(type));
    expect(seen).toEqual(["agent_settled", "agent_end", "session_compact"]);
    expect(received).toEqual(["agent_settled", "agent_end", "session_compact"]);
    detach();
    expect(unbind).toHaveBeenCalledTimes(3);
  });

  it("retains active, recent, and unflushed sessions and prunes only old ended owned files", () => {
    const state = mkdtempSync(join(tmpdir(), "pi-state-"));
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager, flush } = makeSessionManager();
    const oldBinding = allocatePiBinding(state, bindingParams(ws));
    openPiConversation(manager, state, oldBinding);
    const oldFile = flush(oldBinding.conversationId, oldBinding.sessionDir);
    openPiConversation(manager, state, oldBinding);
    const recentBinding = allocatePiBinding(state, bindingParams(ws));
    openPiConversation(manager, state, recentBinding);
    const pendingBinding = allocatePiBinding(state, bindingParams(ws));
    openPiConversation(manager, state, pendingBinding);

    const now = Date.now();
    markPiConversationEnded(state, oldBinding.conversationId, now - 8 * 24 * 60 * 60 * 1000);
    const report = sweepPiRetention(state, now, (id) => id === recentBinding.conversationId);
    expect(report.removed).toEqual([oldBinding.conversationId]);
    expect(existsSync(oldFile)).toBe(false);
  });

  it("persists reconstruction progress across restarts", () => {
    const state = mkdtempSync(join(tmpdir(), "pi-state-"));
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const binding = allocatePiBinding(state, bindingParams(ws));
    openPiConversation(manager, state, binding);
    expect(loadPiReseedProgress(state, "unknown-id")).toEqual({ seeded: 0, currentAdmitted: false });

    savePiReseedProgress(state, binding.conversationId, { seeded: 2, currentAdmitted: true });
    expect(loadPiReseedProgress(state, binding.conversationId)).toEqual({ seeded: 2, currentAdmitted: true });
  });

  it("seeds archive context as ordinary turns through the public append API", () => {
    const appended: Array<{ role: string; content: unknown; timestamp: number }> = [];
    const writer = seedWriterForSessionManager({
      appendMessage: (message) => {
        appended.push({ role: message.role, content: message.content, timestamp: message.timestamp });
        return "entry-id";
      },
    });
    writer.appendSeed({ role: "user", text: "seed", timestamp: 7 });
    writer.appendSeed({ role: "assistant", text: "answer", timestamp: 8 });
    expect(appended).toEqual([
      { role: "user", content: [{ type: "text", text: "seed" }], timestamp: 7 },
      { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 8 },
    ]);
    const assistant = appended[1] as { role: string; timestamp: number };
    expect(assistant.role).toBe("assistant");
  });

  it("preserves reconstruction progress across reopen", () => {
    const state = mkdtempSync(join(tmpdir(), "pi-state-"));
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const binding = allocatePiBinding(state, bindingParams(ws));
    openPiConversation(manager, state, binding);
    savePiReseedProgress(state, binding.conversationId, { seeded: 2, currentAdmitted: true });

    openPiConversation(manager, state, binding);
    expect(loadPiReseedProgress(state, binding.conversationId)).toEqual({ seeded: 2, currentAdmitted: true });
  });

  it("keeps an ownership tombstone after erasure so the id cannot be reused", () => {
    const state = mkdtempSync(join(tmpdir(), "pi-state-"));
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const binding = allocatePiBinding(state, bindingParams(ws));
    openPiConversation(manager, state, binding);
    erasePiConversation(state, binding.conversationId);

    expect(() => openPiConversation(manager, state, binding)).toThrow(/erased/);
    const otherPrincipal = { ...bindingParams(ws), principal: "user-2" };
    const hijack = { ...allocatePiBinding(state, otherPrincipal), conversationId: binding.conversationId };
    expect(() => openPiConversation(manager, state, hijack)).toThrow(/erased/);
  });

  it("denies a workspace mismatch for the same principal and role", () => {
    const state = mkdtempSync(join(tmpdir(), "pi-state-"));
    const wsA = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const wsB = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const binding = allocatePiBinding(state, bindingParams(wsA));
    openPiConversation(manager, state, binding);

    const otherWorkspace = allocatePiBinding(state, bindingParams(wsB));
    const hijack = { ...otherWorkspace, conversationId: binding.conversationId };
    expect(() => openPiConversation(manager, state, hijack)).toThrow(/workspace/);
  });

  it("defers retention instead of tombstoning when an owned file cannot be removed", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const stateRoot = join(root, "pi-sessions");
    const { manager, flush } = makeSessionManager();
    const binding = allocatePiBinding(stateRoot, bindingParams(ws));
    openPiConversation(manager, stateRoot, binding);
    const file = flush(binding.conversationId, binding.sessionDir);
    openPiConversation(manager, stateRoot, binding);

    // Make the owned path unremovable as a file: replace it with a directory.
    rmSync(file);
    mkdirSync(file);

    const now = Date.now();
    markPiConversationEnded(stateRoot, binding.conversationId, now - 8 * 24 * 60 * 60 * 1000);
    const report = sweepPiRetention(stateRoot, now, () => false);
    expect(report.removed).toEqual([]);
    expect(report.kept).toContain(binding.conversationId);
    expect(existsSync(file)).toBe(true);
  });

  it("erases owned files without touching standalone sessions", () => {    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const state = root;
    const standalone = join(root, "standalone.jsonl");
    writeFileSync(standalone, JSON.stringify({ type: "session", id: "standalone" }) + "\n");
    const { manager, flush } = makeSessionManager();
    const binding = allocatePiBinding(state, bindingParams(ws));
    openPiConversation(manager, state, binding);
    const file = flush(binding.conversationId, binding.sessionDir);
    openPiConversation(manager, state, binding);

    const report = erasePiConversation(state, binding.conversationId);
    expect(report.removedFiles).toEqual([file]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(standalone)).toBe(true);
  });
});
