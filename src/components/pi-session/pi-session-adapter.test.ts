import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocatePiBinding,
  bindPiObservers,
  cancelPiConversation,
  erasePiConversation,
  forkPiConversation,
  isTerminalPiEvent,
  mapPiEventType,
  markPiConversationEnded,
  openPiConversation,
  sweepPiRetention,
  type PiAgentSessionShape,
  type PiSessionManagerCtor,
} from "./pi-session-adapter.js";
import { allocatePiSuccessor } from "./pi-conversation-identity.js";

function writeHeader(file: string, id: string): void {
  writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n");
}

function makeSessionManager() {
  const calls: string[] = [];
  const manager: PiSessionManagerCtor = {
    create(cwd: string, sessionDir?: string, options?: { id?: string }) {
      calls.push(`create:${options?.id}`);
      writeHeader(join(sessionDir ?? "", `${options?.id}.jsonl`), options?.id ?? "");
      return {};
    },
    open(path: string) {
      calls.push(`open:${path}`);
      return {};
    },
    findById(_cwd: string, id: string, sessionDir?: string) {
      const candidate = join(sessionDir ?? "", `${id}.jsonl`);
      return existsSync(candidate) ? candidate : undefined;
    },
    forkFrom(sourcePath: string, _targetCwd: string, sessionDir?: string, options?: { id?: string }) {
      calls.push(`fork:${options?.id}`);
      if (!existsSync(sourcePath)) throw new Error("missing source");
      writeHeader(join(sessionDir ?? "", `${options?.id}.jsonl`), options?.id ?? "");
      return {};
    },
  };
  return { manager, calls };
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
  it("creates with the abtars-minted ID when no session exists", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager, calls } = makeSessionManager();
    const binding = allocatePiBinding(join(root, "pi-sessions"), bindingParams(workspace));

    const handle = openPiConversation(manager, join(root, "pi-sessions"), binding);
    expect(handle.canonicalFile).toBe(join(binding.sessionDir, `${binding.conversationId}.jsonl`));
    expect(calls.some((call) => call === `create:${binding.conversationId}`)).toBe(true);
  });

  it("reopens an intact conversation under its existing ID", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const stateRoot = join(root, "pi-sessions");
    const { manager, calls } = makeSessionManager();
    const binding = allocatePiBinding(stateRoot, bindingParams(workspace));

    openPiConversation(manager, stateRoot, binding);
    const reopened = openPiConversation(manager, stateRoot, binding);
    expect(reopened.canonicalFile).toContain(binding.conversationId);
    expect(calls.filter((call) => call.startsWith("create:")).length).toBe(1);
  });

  it("refuses a header mismatch instead of adopting the file", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const stateRoot = join(root, "pi-sessions");
    const { manager } = makeSessionManager();
    const binding = allocatePiBinding(stateRoot, bindingParams(workspace));

    openPiConversation(manager, stateRoot, binding);
    writeHeader(join(binding.sessionDir, `${binding.conversationId}.jsonl`), "impostor");

    expect(() => openPiConversation(manager, stateRoot, binding)).toThrow(/verification/);
  });

  it("forks only through a preallocated successor", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const stateRoot = join(root, "pi-sessions");
    const { manager, calls } = makeSessionManager();
    const source = openPiConversation(manager, stateRoot, allocatePiBinding(stateRoot, bindingParams(workspace)));
    const successor = allocatePiSuccessor(source.binding);

    const forked = forkPiConversation(manager, stateRoot, source, successor);
    expect(forked.binding.predecessorId).toBe(source.binding.conversationId);
    expect(calls.some((call) => call === `fork:${successor.conversationId}`)).toBe(true);

    const rogue = allocatePiBinding(stateRoot, bindingParams(workspace));
    expect(() => forkPiConversation(manager, stateRoot, source, rogue)).toThrow(/predecessor/);
  });

  it("cancels under a closed gate with explicit queue draining", async () => {
    const session: PiAgentSessionShape = {
      clearQueue: () => ({ steering: ["s1"], followUp: ["f1"] }),
      abort: async () => {},
      waitForIdle: async () => {},
      on: () => () => {},
    };
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const stateRoot = join(root, "pi-sessions");
    const { manager } = makeSessionManager();
    const handle = openPiConversation(manager, stateRoot, allocatePiBinding(stateRoot, bindingParams(workspace)));

    const result = await cancelPiConversation(session, handle, 1000);
    expect(handle.admissionOpen).toBe(false);
    expect(result.drainedSteering).toEqual(["s1"]);
    expect(result.drainedFollowUp).toEqual(["f1"]);
    expect(result.settled).toBe(true);
  });

  it("reports unsettled instead of hanging when idle never arrives", async () => {    const session: PiAgentSessionShape = {
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => {},
      waitForIdle: () => new Promise<void>(() => {}),
      on: () => () => {},
    };
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const stateRoot = join(root, "pi-sessions");
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

  it("retains active and recent sessions and prunes only old ended owned files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const stateRoot = join(root, "pi-sessions");
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const { manager } = makeSessionManager();
    const oldBinding = allocatePiBinding(stateRoot, bindingParams(ws));
    const oldHandle = openPiConversation(manager, stateRoot, oldBinding);
    const recentHandle = openPiConversation(manager, stateRoot, allocatePiBinding(stateRoot, bindingParams(ws)));

    const now = Date.now();
    markPiConversationEnded(stateRoot, oldBinding.conversationId, now - 8 * 24 * 60 * 60 * 1000);
    const report = sweepPiRetention(stateRoot, now, (id) => id === recentHandle.binding.conversationId);
    expect(report.removed).toEqual([oldBinding.conversationId]);
    expect(existsSync(oldHandle.canonicalFile)).toBe(false);
    expect(existsSync(recentHandle.canonicalFile)).toBe(true);
  });

  it("erases owned files without touching standalone sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const stateRoot = join(root, "pi-sessions");
    const standalone = join(root, "standalone.jsonl");
    writeHeader(standalone, "standalone");
    const { manager } = makeSessionManager();
    const handle = openPiConversation(manager, stateRoot, allocatePiBinding(stateRoot, bindingParams(ws)));

    const report = erasePiConversation(stateRoot, handle.binding.conversationId);
    expect(report.removedFiles).toEqual([handle.canonicalFile]);
    expect(existsSync(handle.canonicalFile)).toBe(false);
    expect(existsSync(standalone)).toBe(true);
  });
});
