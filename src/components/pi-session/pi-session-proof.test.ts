import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/* Boundary-exempt proof test: exercises the real Pi SDK SessionManager
 * (static import is allowed in *.test.ts) with abtars-minted IDs. No
 * providers, no subprocesses, no network: only local session files. */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  allocatePiBinding,
  openPiConversation,
  forkPiConversation,
  seedWriterForSessionManager,
  type PiSessionManagerCtor,
} from "./pi-session-adapter.js";
import { allocatePiSuccessor } from "./pi-conversation-identity.js";

const realSessionManager = SessionManager as unknown as PiSessionManagerCtor;

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "pi-proof-ws-"));
}

function params(workspace: string, principal = "user-1", role: "worker" | "main" = "worker") {
  return {
    principal,
    platform: "telegram",
    role,
    workspaceAlias: "repo-a",
    canonicalWorkspace: workspace,
    memoryScope: "abmind" as const,
  };
}

describe("pi-session real-SDK proof (R1-R2)", () => {
  it("creates with the abtars-minted ID and reports unflushed files", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-proof-"));
    const binding = allocatePiBinding(stateRoot, params(makeWorkspace()));

    const handle = openPiConversation(realSessionManager, stateRoot, binding);
    expect(handle.binding.conversationId).toBe(binding.conversationId);
    expect(handle.canonicalFile).toBeNull();
  });

  it("reopens flushed history and forks it with predecessor lineage", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-proof-"));
    const workspace = makeWorkspace();
    const binding = allocatePiBinding(stateRoot, params(workspace));

    // Real SDK flush: create plus one user message persists the file.
    // Custom-only entries stay in memory by SDK design, so the seed is a
    // real user turn written through the production seed writer.
    const direct = SessionManager.create(workspace, binding.sessionDir, { id: binding.conversationId });
    seedWriterForSessionManager(direct).appendSeed({
      role: "user",
      text: "proof-seed-history",
      timestamp: Date.now(),
    });

    const reopened = openPiConversation(realSessionManager, stateRoot, binding);
    expect(reopened.canonicalFile).not.toBeNull();

    const successor = allocatePiSuccessor(binding);
    const forked = forkPiConversation(realSessionManager, stateRoot, reopened, successor);
    expect(forked.binding.predecessorId).toBe(binding.conversationId);
    expect(forked.canonicalFile).not.toBeNull();
    const forkedText = readFileSync(forked.canonicalFile ?? "", "utf-8");
    expect(forkedText).toContain("proof-seed-history");
  });

  it("continues one worker conversation across attempts with role isolation", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-proof-"));
    const workspace = makeWorkspace();
    const main = allocatePiBinding(stateRoot, params(workspace, "user-1", "main"));
    const worker = allocatePiBinding(stateRoot, params(workspace, "user-1", "worker"));
    expect(main.sessionDir).not.toBe(worker.sessionDir);

    openPiConversation(realSessionManager, stateRoot, main);
    openPiConversation(realSessionManager, stateRoot, worker);

    const direct = SessionManager.create(workspace, worker.sessionDir, { id: worker.conversationId });
    direct.appendMessage({
      role: "user",
      content: [{ type: "text", text: "worker attempt evidence" }],
      timestamp: Date.now(),
    });

    const attempt2 = openPiConversation(realSessionManager, stateRoot, worker);
    const attempt3 = openPiConversation(realSessionManager, stateRoot, worker);
    expect(attempt2.canonicalFile).not.toBeNull();
    expect(attempt3.canonicalFile).toBe(attempt2.canonicalFile);

    const hijack = { ...main, conversationId: worker.conversationId };
    expect(() => openPiConversation(realSessionManager, stateRoot, hijack)).toThrow(/different principal, role, or workspace/);
  });

  it("isolates principals into separate partitions", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "pi-proof-"));
    const workspace = makeWorkspace();
    const first = allocatePiBinding(stateRoot, params(workspace, "user-1", "main"));
    const second = allocatePiBinding(stateRoot, params(workspace, "user-2", "main"));

    expect(first.sessionDir).not.toBe(second.sessionDir);
    const handleA = openPiConversation(realSessionManager, stateRoot, first);
    const handleB = openPiConversation(realSessionManager, stateRoot, second);
    expect(handleA.binding.conversationId).not.toBe(handleB.binding.conversationId);
  });
});
