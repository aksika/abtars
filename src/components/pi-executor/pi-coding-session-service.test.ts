/**
 * pi-coding-session-service.test.ts — #1635 interactive turn lifecycle.
 *
 * Uses the controllable fake Pi RPC client, a real session store + claim
 * store over SQLite, the real runtime host, and real session files under a
 * real session storage root.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PiCodingSessionStore } from "./pi-coding-session-store.js";
import { PiWorkspaceClaimStore } from "./pi-workspace-claim-store.js";
import { PiRuntimeHost } from "./pi-runtime-host.js";
import { PiCodingSessionService, type PiCodingProjectionSink } from "./pi-coding-session-service.js";
import type { PiExecutorConfig } from "./config.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

// ── controllable RPC fake (module-mocked into ./pi-rpc-client.js) ───────────

const fake = vi.hoisted(() => {
  type Call = { method: string; args: unknown[] };
  class FakeClient {
    static instances: FakeClient[] = [];
    static defaultState: { sessionId: string; sessionFile?: string; isStreaming: boolean; isCompacting: boolean } = {
      sessionId: "fresh-process", sessionFile: undefined, isStreaming: false, isCompacting: false,
    };
    static onSwitch: ((file: string, client: FakeClient) => void) | null = null;
    static promptError: Error | null = null;
    pid = 4242;
    closed = false;
    calls: Call[] = [];
    prompts: string[] = [];
    followUps: string[] = [];
    steers: string[] = [];
    switches: string[] = [];
    state: { sessionId: string; sessionFile?: string; isStreaming: boolean; isCompacting: boolean };
    private subs = new Set<(e: unknown) => void>();
    private termCbs = new Set<(e: unknown) => void>();
    private uiCbs = new Set<(e: unknown) => void>();
    constructor() {
      this.state = { ...FakeClient.defaultState };
      FakeClient.instances.push(this);
    }
    record(method: string, args: unknown[] = []): void { this.calls.push({ method, args }); }
    async launch(...args: unknown[]): Promise<void> { this.record("launch", args); }
    async getState(): Promise<{ sessionId: string; sessionFile?: string; isStreaming: boolean; isCompacting: boolean }> {
      this.record("getState");
      return this.state;
    }
    async getAvailableModels(): Promise<Array<{ id: string }>> { return [{ id: "model-x" }]; }
    async setModel(...args: unknown[]): Promise<void> { this.record("setModel", args); }
    async prompt(text: string): Promise<void> {
      this.record("prompt", [text]);
      if (FakeClient.promptError) throw FakeClient.promptError;
      this.prompts.push(text);
    }
    async followUp(text: string): Promise<void> { this.record("followUp", [text]); this.followUps.push(text); }
    async steer(text: string): Promise<void> { this.record("steer", [text]); this.steers.push(text); }
    async switchSession(file: string): Promise<{ cancelled: boolean }> {
      this.record("switchSession", [file]); this.switches.push(file);
      FakeClient.onSwitch?.(file, this);
      return { cancelled: false };
    }
    async compact(): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number }> {
      this.record("compact");
      return { summary: "ok", firstKeptEntryId: "e1", tokensBefore: 100 };
    }
    async respondToUi(...args: unknown[]): Promise<{ ok: boolean; delivery: string }> { this.record("respondToUi", args); return { ok: true, delivery: "written_unacknowledged" }; }
    async getLastAssistantText(): Promise<string | null> { this.record("getLastAssistantText"); return "done"; }
    async getSessionStats(): Promise<Record<string, unknown>> { this.record("getSessionStats"); return { turns: 1 }; }
    async abort(): Promise<void> { this.record("abort"); }
    async close(): Promise<void> { this.record("close"); this.closed = true; }
    async closeAndWait(): Promise<void> { await this.close(); }
    onTermination(cb: (e: unknown) => void): () => void { this.termCbs.add(cb); return () => this.termCbs.delete(cb); }
    subscribe(cb: (e: unknown) => void): () => void { this.subs.add(cb); return () => this.subs.delete(cb); }
    onUiRequest(cb: (e: unknown) => void): () => void { this.uiCbs.add(cb); return () => this.uiCbs.delete(cb); }
    emitTermination(e: unknown): void { for (const cb of [...this.termCbs]) cb(e); }
    emitEvent(e: unknown): void { for (const cb of [...this.subs]) cb(e); }
    static reset(): void {
      FakeClient.instances = [];
      FakeClient.defaultState = { sessionId: "fresh-process", sessionFile: undefined, isStreaming: false, isCompacting: false };
      FakeClient.onSwitch = null;
      FakeClient.promptError = null;
    }
  }
  return { FakeClient };
});

vi.mock("./pi-rpc-client.js", () => ({
  SupervisedPiRpcClient: fake.FakeClient,
}));

const _require = createRequire(import.meta.url);
const sharedPath = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
const Database: typeof import("better-sqlite3") = _require(sharedPath);

function createTestDb(): TaskDatabase {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]) { return stmt.run(...params); },
        get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
        all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { raw.exec(sql); },
    transaction<T>(fn: () => T): T { return raw.transaction(fn)(); },
  };
}

function makeSpinStub() {
  const allocated: Array<{ userId: string; platform: string; name: string; codingSessionId: string }> = [];
  let seq = 0;
  return {
    allocated,
    ended: [] as string[],
    allocateCodingExternalSession(spec: { userId: string; platform: string; name: string; workingDir: string; codingSessionId: string }) {
      seq += 1;
      allocated.push(spec);
      return { id: `spin-c-${seq}`, name: spec.name, workingDir: spec.workingDir };
    },
    endCodingExternalSession(sessionId: string): boolean {
      this.ended.push(sessionId);
      return true;
    },
  };
}

interface Harness {
  store: PiCodingSessionStore;
  claims: PiWorkspaceClaimStore;
  service: PiCodingSessionService;
  host: PiRuntimeHost;
  spin: ReturnType<typeof makeSpinStub>;
  sink: PiCodingProjectionSink & { events: Array<{ kind: string; sessionId: string; text?: string }> };
  root: string;
  wsPath: string;
  config: PiExecutorConfig;
  cleanup: () => void;
}

let harness: Harness;

function makeHarness(opts?: { maxConcurrent?: number }): Harness {
  const root = mkdtempSync(join(tmpdir(), "pi-coding-test-"));
  const wsPath = join(root, "ws");
  mkdirSync(wsPath, { recursive: true });
  const db = createTestDb();
  const store = new PiCodingSessionStore(db);
  const claims = new PiWorkspaceClaimStore(db);
  const config: PiExecutorConfig = {
    enabled: true, command: "fake-pi", fixedArgs: [],
    workspaceAliases: { "repo-a": { path: wsPath } },
    allowedEnv: [], maxConcurrent: opts?.maxConcurrent ?? 2, maxWallClockMs: 60000, abortGraceMs: 200,
    projectTrust: "never", sessionStorageRoot: root,
  };
  const host = new PiRuntimeHost(config);
  const spin = makeSpinStub();
  const events: Harness["sink"]["events"] = [];
  const sink: PiCodingProjectionSink = {
    progress: (sessionId, text) => { events.push({ kind: "progress", sessionId, text }); },
    tool: (sessionId, name, started) => { events.push({ kind: `tool_${started ? "start" : "end"}`, sessionId, text: name }); },
    uiRequest: (sessionId) => { events.push({ kind: "ui_request", sessionId }); },
    assistantText: (sessionId, text) => { events.push({ kind: "assistant_text", sessionId, text }); },
    turnComplete: (sessionId, summary) => { events.push({ kind: "turn_complete", sessionId, text: summary.error ?? "" }); },
    busy: (sessionId, reason) => { events.push({ kind: "busy", sessionId, text: reason }); },
    retry: (sessionId, reason) => { events.push({ kind: "retry", sessionId, text: reason }); },
    notResumable: (sessionId, _capability, reason) => { events.push({ kind: "not_resumable", sessionId, text: reason }); },
  };
  const service = new PiCodingSessionService({ store, claims, host, config, spin: spin as never, sink });
  return {
    store, claims, service, host, spin, sink: { ...sink, events },
    root, wsPath, config,
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

function writeSession(root: string, file: string, id: string): string {
  const path = join(root, file);
  writeFileSync(path, JSON.stringify({ type: "session", id }) + "\n", "utf-8");
  return path;
}

function createSession(h: Harness, owner = "usr-1"): string {
  return h.service.createCodingSession({ ownerPrincipal: owner, workspaceAlias: "repo-a" }).sessionId;
}

/** agent_end event as Pi emits it after a completed turn. */
function agentEnd(): { type: "agent_end"; willRetry: false } {
  return { type: "agent_end", willRetry: false };
}

beforeEach(() => {
  fake.FakeClient.reset();
  harness = makeHarness();
});

afterEach(() => {
  harness.cleanup();
});

describe("PiCodingSessionService #1635 — turn lifecycle", () => {
  it("two sequential turns run on ONE transcript with idle between them (never settles)", async () => {
    const h = harness;
    const sessionId = createSession(h);
    const savedFile = writeSession(h.root, "t1.jsonl", "sess-1");
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };

    const first = await h.service.startTurn({ sessionId, text: "first prompt", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    expect(first.kind).toBe("started");
    let rec = h.store.get(sessionId)!;
    expect(rec.state).toBe("running");
    expect(rec.runtimeGeneration).toBe(2);
    expect(rec.leaseGeneration).toBe(2);
    // the workspace claim is held while the turn runs
    expect(h.claims.list()).toHaveLength(1);

    // agent_end — the turn completes, session returns to idle, nothing settles
    const client = fake.FakeClient.instances[0]!;
    client.emitEvent(agentEnd());
    await vi.waitFor(() => {
      expect(h.store.get(sessionId)!.state).toBe("idle");
    });
    rec = h.store.get(sessionId)!;
    expect(rec.state).toBe("idle");
    expect(rec.piSessionId).toBe("sess-1");
    expect(rec.resumeCapability).toBe("available");
    expect(rec.runtimeGeneration).toBe(2);
    expect(h.sink.events.filter(e => e.kind === "assistant_text")).toEqual([
      { kind: "assistant_text", sessionId, text: "done" },
    ]);
    // every generation-owned resource is released: no lease, no claim, no live turn
    expect(rec.leaseGeneration).toBeUndefined();
    expect(h.claims.list()).toHaveLength(0);
    expect(h.service.liveCount).toBe(0);
    expect(client.closed).toBe(true);

    // second turn on the same transcript — resumed, same pi session identity
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
    const second = await h.service.startTurn({ sessionId, text: "second prompt", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    expect(second.kind).toBe("started");
    rec = h.store.get(sessionId)!;
    expect(rec.state).toBe("running");
    expect(rec.runtimeGeneration).toBe(3);
    const client2 = fake.FakeClient.instances[1]!;
    // resume switched to the proven file before prompting
    expect(client2.switches).toContain(savedFile);
    expect(client2.prompts).toEqual(["second prompt"]);
    client2.emitEvent(agentEnd());
    await vi.waitFor(() => {
      expect(h.store.get(sessionId)!.state).toBe("idle");
    });
    rec = h.store.get(sessionId)!;
    expect(rec.piSessionId).toBe("sess-1");
    expect(rec.runtimeGeneration).toBe(3);
    expect(h.claims.list()).toHaveLength(0);
  });

  it("a mid-turn message becomes follow_up on the same process", async () => {
    const h = harness;
    const sessionId = createSession(h);
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: writeSession(h.root, "t.jsonl", "sess-1"), isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    const result = await h.service.followUp(sessionId, "more", "usr-1");
    expect(result.kind).toBe("started");
    expect(fake.FakeClient.instances[0]!.followUps).toEqual(["more"]);
    // still one live process, one claim
    expect(h.service.liveCount).toBe(1);
    expect(h.claims.list()).toHaveLength(1);
  });

  it("steer goes to the Pi steer RPC", async () => {
    const h = harness;
    const sessionId = createSession(h);
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: writeSession(h.root, "t.jsonl", "sess-1"), isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    const result = await h.service.steer(sessionId, "different direction", "usr-1");
    expect(result.kind).toBe("started");
    expect(fake.FakeClient.instances[0]!.steers).toEqual(["different direction"]);
  });

  it("stop aborts the turn and leaves the session alive and idle", async () => {
    const h = harness;
    const sessionId = createSession(h);
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: writeSession(h.root, "t.jsonl", "sess-1"), isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    expect(await h.service.stop(sessionId, "usr-1")).toBe(true);
    await vi.waitFor(() => {
      expect(h.store.get(sessionId)!.state).toBe("idle");
    });
    const rec = h.store.get(sessionId)!;
    expect(rec.state).toBe("idle");
    expect(rec.runtimeGeneration).toBe(2); // same generation — no settle, no new row
    expect(h.claims.list()).toHaveLength(0);
    expect(rec.leaseGeneration).toBeUndefined();
  });

  it("a running interactive turn blocks a coding worker on the same canonical path", async () => {
    const h = harness;
    const sessionId = createSession(h);
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: writeSession(h.root, "t.jsonl", "sess-1"), isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    expect(h.claims.list()).toHaveLength(1);

    // a standalone /pi run on the same canonical workspace must see busy
    const workerClaim = h.claims.tryAcquireInTx({
      canonicalPath: h.wsPath,
      ownerId: "run-worker-1",
      generation: 1,
      ownerKind: "standalone",
    });
    expect(workerClaim.kind).toBe("busy");
  });

  it("an idle interactive session does NOT block a coding worker (no resident claim)", async () => {
    const h = harness;
    const sessionId = createSession(h);
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: writeSession(h.root, "t.jsonl", "sess-1"), isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    fake.FakeClient.instances[0]!.emitEvent(agentEnd());
    await vi.waitFor(() => {
      expect(h.store.get(sessionId)!.state).toBe("idle");
    });
    // no live process, no claim — the checkout is free for autonomous work
    expect(h.claims.list()).toHaveLength(0);
    expect(h.service.liveCount).toBe(0);
    const workerClaim = h.claims.tryAcquireInTx({
      canonicalPath: h.wsPath,
      ownerId: "run-worker-2",
      generation: 1,
      ownerKind: "standalone",
    });
    expect(workerClaim.kind).toBe("claimed");
    h.claims.releaseForGeneration({ ownerId: "run-worker-2", generation: 1 });
  });

  it("a busy workspace claim reports a bounded busy state and leaves the session idle", async () => {
    const h = harness;
    const sessionId = createSession(h);
    // a worker already holds the checkout
    h.claims.tryAcquireInTx({ canonicalPath: h.wsPath, ownerId: "run-holder", generation: 1, ownerKind: "standalone" });
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: writeSession(h.root, "t.jsonl", "sess-1"), isStreaming: false, isCompacting: false };
    const result = await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    expect(result.kind).toBe("busy");
    const rec = h.store.get(sessionId)!;
    expect(rec.state).toBe("idle"); // nothing half-started
    expect(rec.runtimeGeneration).toBe(1); // generation never advanced
    expect(h.claims.list()).toHaveLength(1); // only the worker's claim
    expect(h.service.liveCount).toBe(0);
    expect(h.host.reservedCount).toBe(0); // slot released
  });

  it("a Pi launch failure releases the shared slot, claim, and lease", async () => {
    const h = harness;
    const sessionId = createSession(h);
    vi.spyOn(h.host, "launch").mockResolvedValue({ ok: false, error: "Pi unavailable" });

    const result = await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });

    expect(result).toEqual({ kind: "error", reason: "Pi unavailable" });
    expect(h.host.reservedCount).toBe(0);
    expect(h.claims.list()).toHaveLength(0);
    expect(h.store.get(sessionId)!.state).toBe("idle");
    expect(h.store.get(sessionId)!.leaseGeneration).toBeUndefined();
  });

  it("duplicate agent_end events complete once and release one shared slot", async () => {
    const h = harness;
    const sessionId = createSession(h);
    const savedFile = writeSession(h.root, "duplicate.jsonl", "sess-1");
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });

    const client = fake.FakeClient.instances[0]!;
    client.emitEvent(agentEnd());
    client.emitEvent(agentEnd());
    await vi.waitFor(() => expect(h.store.get(sessionId)!.state).toBe("idle"));

    expect(h.host.reservedCount).toBe(0);
    expect(h.service.liveCount).toBe(0);
    expect(h.sink.events.filter(e => e.kind === "assistant_text")).toHaveLength(1);
    expect(h.sink.events.filter(e => e.kind === "turn_complete")).toHaveLength(1);
  });

  it("final identity proof failure preserves the last identity and downgrades resumability", async () => {
    const h = harness;
    const sessionId = createSession(h);
    const savedFile = writeSession(h.root, "final-proof.jsonl", "sess-1");
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });

    const client = fake.FakeClient.instances[0]!;
    client.state = { sessionId: "sess-1", sessionFile: undefined, isStreaming: false, isCompacting: false };
    client.emitEvent(agentEnd());
    await vi.waitFor(() => expect(h.store.get(sessionId)!.state).toBe("idle"));

    const rec = h.store.get(sessionId)!;
    expect(rec.piSessionId).toBe("sess-1");
    expect(rec.piSessionFile).toBe(savedFile);
    expect(rec.resumeCapability).toBe("session_missing");
  });

  it("a message racing startup gets a bounded retry response, never a second process", async () => {
    const h = harness;
    const sessionId = createSession(h);
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: writeSession(h.root, "t.jsonl", "sess-1"), isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    // simulate a second message while starting — no live turn yet but not idle
    h.store.casTransition(sessionId, "running", "starting", {}, 2);
    const result = await h.service.startTurn({ sessionId, text: "again", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
    expect(result.kind).toBe("retry");
    expect(fake.FakeClient.instances).toHaveLength(1);
  });

  it("memoryMode none means the child env carries no ABMIND correlation", async () => {
    const h = harness;
    const sessionId = createSession(h);
    const rec = h.store.get(sessionId)!;
    expect(rec.memoryMode).toBe("none");
    const { buildChildEnv } = await import("./config.js");
    const none = buildChildEnv(h.config, { id: "s", ownerPrincipalId: "u", executionGeneration: 1 }, "none");
    expect(none["ABMIND_HOOKS_DISABLED"]).toBe("true");
    expect(none["ABMIND_USER_ID"]).toBeUndefined();
    expect(none["ABMIND_PARENT_EXECUTION_ID"]).toBeUndefined();
    expect(none["ABMIND_AUTOMATIC_WRITE_OWNER"]).toBeUndefined();
    const abmind = buildChildEnv(h.config, { id: "s", ownerPrincipalId: "u", executionGeneration: 1 }, "abmind");
    expect(abmind["ABMIND_HOOKS_DISABLED"]).toBeUndefined();
    expect(abmind["ABMIND_USER_ID"]).toBe("u");
  });

  it("endSession ends the durable row and the envelope, preserving the transcript", async () => {
    const h = harness;
    const sessionId = createSession(h);
    expect(h.service.endSession(sessionId, "usr-1")).toBe(true);
    const rec = h.store.get(sessionId)!;
    expect(rec.state).toBe("ended");
    expect(h.spin.ended).toContain(sessionId);
    expect(h.service.listForOwner("usr-1")).toHaveLength(0);
  });

  it("active end waits for Pi teardown before ending the envelope", async () => {
    const h = harness;
    const sessionId = createSession(h);
    fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: writeSession(h.root, "end.jsonl", "sess-1"), isStreaming: false, isCompacting: false };
    await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });

    expect(h.service.endSession(sessionId, "usr-1")).toBe(true);
    expect(h.spin.ended).not.toContain(sessionId);
    expect(h.store.get(sessionId)!.state).toBe("running");
    await vi.waitFor(() => expect(h.service.liveCount).toBe(0));
    expect(h.store.get(sessionId)!.state).toBe("ended");
    expect(h.spin.ended).toContain(sessionId);
    expect(h.host.reservedCount).toBe(0);
  });

  it("a non-owner cannot start a turn", async () => {
    const h = harness;
    const sessionId = createSession(h);
    const result = await h.service.startTurn({ sessionId, text: "hijack", ownerPrincipal: "usr-2", leaseOwner: "tg:2" });
    expect(result.kind).toBe("error");
    expect(h.store.get(sessionId)!.state).toBe("idle");
  });

  describe("resume and restart reconciliation #1635", () => {
    it("a missing session file refuses resume with a truthful capability and submits nothing", async () => {
      const h = harness;
      const sessionId = createSession(h);
      const savedFile = writeSession(h.root, "t.jsonl", "sess-1");
      fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
      await h.service.startTurn({ sessionId, text: "first", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
      fake.FakeClient.instances[0]!.emitEvent(agentEnd());
      await vi.waitFor(() => {
        expect(h.store.get(sessionId)!.state).toBe("idle");
      });
      expect(h.store.get(sessionId)!.resumeCapability).toBe("available");
      // the transcript disappears out-of-band
      rmSync(savedFile);
      fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: undefined, isStreaming: false, isCompacting: false };
      const result = await h.service.startTurn({ sessionId, text: "second", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
      expect(result.kind).toBe("not_resumable");
      if (result.kind === "not_resumable") {
        expect(result.capability).toBe("session_missing");
      }
      const rec = h.store.get(sessionId)!;
      expect(rec.resumeCapability).toBe("session_missing");
      expect(rec.state).toBe("idle");
      // nothing was submitted to a fresh process and no second process survived
      expect(fake.FakeClient.instances[1]!.prompts).toEqual([]);
      expect(h.service.liveCount).toBe(0);
      expect(h.claims.list()).toHaveLength(0);
    });

    it("reconcileOnBoot marks a live session interrupted with a proof-derived capability", async () => {
      const h = harness;
      const sessionId = createSession(h);
      const savedFile = writeSession(h.root, "t.jsonl", "sess-1");
      fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
      await h.service.startTurn({ sessionId, text: "go", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
      // simulate a crash: the process is gone but the row is still running with a lease + claim
      expect(h.claims.list()).toHaveLength(1);
      h.service.reconcileOnBoot();
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("interrupted");
      expect(rec.resumeCapability).toBe("available");
      expect(rec.leaseGeneration).toBeUndefined();
      expect(h.claims.list()).toHaveLength(0);
    });

    it("reconcileOnBoot yields never_started when no identity was ever established", async () => {
      const h = harness;
      const sessionId = createSession(h);
      h.store.casTransition(sessionId, "idle", "running", { observedPid: 123, pendingRequestId: null, pendingRequestType: null }, 1);
      h.claims.tryAcquireInTx({ canonicalPath: h.wsPath, ownerId: sessionId, generation: 1, ownerKind: "interactive" });
      h.service.reconcileOnBoot();
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("interrupted");
      expect(rec.resumeCapability).toBe("never_started");
      expect(h.claims.list()).toHaveLength(0);
    });

    it("reconcileOnBoot clears stale leases on non-live rows", async () => {
      const h = harness;
      const sessionId = createSession(h);
      h.store.setLease(sessionId, { frontend: "telegram-rpc", owner: "tg:1", generation: 1, acquiredAt: "2026-08-12" }, 1);
      h.service.reconcileOnBoot();
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("idle");
      expect(rec.leaseGeneration).toBeUndefined();
    });

    it("an interrupted session resumes the same transcript after reconciliation", async () => {
      const h = harness;
      const sessionId = createSession(h);
      const savedFile = writeSession(h.root, "t.jsonl", "sess-1");
      fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
      await h.service.startTurn({ sessionId, text: "first", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
      fake.FakeClient.instances[0]!.emitEvent(agentEnd());
      await vi.waitFor(() => {
        expect(h.store.get(sessionId)!.state).toBe("idle");
      });
      // start a second turn (running), then a crash happens before agent_end
      fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
      await h.service.startTurn({ sessionId, text: "second", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
      expect(h.store.get(sessionId)!.state).toBe("running");
      h.service.reconcileOnBoot();
      expect(h.store.get(sessionId)!.state).toBe("interrupted");
      expect(h.store.get(sessionId)!.resumeCapability).toBe("available");
      fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
      const result = await h.service.startTurn({ sessionId, text: "resumed prompt", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
      expect(result.kind).toBe("started");
      const client = fake.FakeClient.instances[2]!;
      expect(client.switches).toContain(savedFile);
      expect(client.prompts).toEqual(["resumed prompt"]);
      expect(h.store.get(sessionId)!.state).toBe("running");
    });
  });
});
