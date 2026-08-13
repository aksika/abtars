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
import { spawnSync } from "node:child_process";
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

  describe("#1635 Phase 2 — native TUI handoff", () => {
    function deadPid(): number {
      const res = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
      return res.pid;
    }

    /** Run one Telegram turn to completion so the row carries a proven identity. */
    async function sessionWithIdentity(h: Harness): Promise<{ sessionId: string; savedFile: string }> {
      const sessionId = createSession(h);
      const savedFile = writeSession(h.root, "t1.jsonl", "sess-1");
      fake.FakeClient.defaultState = { sessionId: "sess-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };
      await h.service.startTurn({ sessionId, text: "first", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
      fake.FakeClient.instances[0]!.emitEvent(agentEnd());
      await vi.waitFor(() => {
        expect(h.store.get(sessionId)!.state).toBe("idle");
      });
      // the RPC process is reaped in reality — clear the observed pid so the
      // handoff's prior-writer check is deterministic (the fake client's
      // synthetic pid 4242 could collide with a live OS process).
      h.store.casTransition(sessionId, "idle", "idle", { observedPid: null });
      return { sessionId, savedFile };
    }

    it("resume handoff from idle holds slot/claim/lease and returns session facts only", async () => {
      const h = harness;
      const { sessionId, savedFile } = await sessionWithIdentity(h);

      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.handoff.piSessionId).toBe("sess-1");
      expect(result.handoff.piSessionFile).toBe(savedFile);
      expect(result.handoff.newPiSessionId).toBeUndefined();
      expect(result.handoff.canonicalPath).toBe(h.wsPath);
      expect(result.handoff.sessionStorageRoot).toBe(h.root);
      expect(result.handoff.workspaceAlias).toBe("repo-a");

      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("starting");
      expect(rec.leaseFrontend).toBe("native-tui");
      expect(rec.leaseOwner).toBe("tui:1");
      expect(rec.leaseGeneration).toBe(rec.runtimeGeneration);
      // the claim and shared slot are held for the whole handoff
      expect(h.claims.list()).toHaveLength(1);
      expect(h.host.reservedCount).toBe(1);

      // Telegram cannot open the same session file while the native lease runs
      // (design §4: a starting session gets a bounded retry — never a second writer)
      const turn = await h.service.startTurn({ sessionId, text: "x", ownerPrincipal: "usr-1", leaseOwner: "tg:1" });
      expect(turn.kind === "busy" || turn.kind === "retry").toBe(true);
      expect(h.store.get(sessionId)!.state).toBe("starting");
      expect(h.claims.list()).toHaveLength(1);
      expect(fake.FakeClient.instances).toHaveLength(1); // no RPC process spawned

      // an autonomous worker stays blocked for the whole handoff (R3.7)
      const workerClaim = h.claims.tryAcquireInTx({
        canonicalPath: h.wsPath,
        ownerId: "run-worker-1",
        generation: 1,
        ownerKind: "standalone",
      });
      expect(workerClaim.kind).toBe("busy");

      // ... and proceeds after exit releases the claim
      h.service.endNativeHandoff({ sessionId, leaseOwner: "tui:1", code: 0 });
      expect(h.claims.list()).toHaveLength(0);
      const afterExit = h.claims.tryAcquireInTx({
        canonicalPath: h.wsPath,
        ownerId: "run-worker-2",
        generation: 1,
        ownerKind: "standalone",
      });
      expect(afterExit.kind).toBe("claimed");
      h.claims.releaseForGeneration({ ownerId: "run-worker-2", generation: 1 });
    });

    it("records the client-spawned pid as the exclusive-writer fence", async () => {
      const h = harness;
      const { sessionId } = await sessionWithIdentity(h);
      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(true);
      h.service.recordNativeHandoffPid({ sessionId, leaseOwner: "tui:1", pid: 77777 });
      expect(h.store.get(sessionId)!.observedPid).toBe(77777);
      // a stale connection cannot write the fence
      h.service.recordNativeHandoffPid({ sessionId, leaseOwner: "tui:other", pid: 88888 });
      expect(h.store.get(sessionId)!.observedPid).toBe(77777);
    });

    it("exit 0 with a valid proof returns the session to idle and releases everything", async () => {
      const h = harness;
      const { sessionId } = await sessionWithIdentity(h);
      h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      h.service.recordNativeHandoffPid({ sessionId, leaseOwner: "tui:1", pid: 77777 });

      const ended = h.service.endNativeHandoff({ sessionId, leaseOwner: "tui:1", code: 0 });
      expect(ended.ok).toBe(true);
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("idle");
      expect(rec.resumeCapability).toBe("available");
      expect(rec.leaseGeneration).toBeUndefined();
      expect(rec.leaseFrontend).toBeUndefined();
      expect(h.claims.list()).toHaveLength(0);
      expect(h.host.reservedCount).toBe(0);
      expect(h.service.nativeHandoffCount).toBe(0);
    });

    it("non-zero exit marks interrupted with a truthful proof-derived capability", async () => {
      const h = harness;
      const { sessionId } = await sessionWithIdentity(h);
      h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      const ended = h.service.endNativeHandoff({ sessionId, leaseOwner: "tui:1", code: 1 });
      expect(ended.ok).toBe(true);
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("interrupted");
      // the transcript is intact — capability stays truthful
      expect(rec.resumeCapability).toBe("available");
      expect(h.claims.list()).toHaveLength(0);
    });

    it("handoff from running fails closed", async () => {
      const h = harness;
      const sessionId = createSession(h);
      // craft a running row directly — no observed pid (the fake pid could
      // collide with a live OS process)
      h.store.casTransition(sessionId, "idle", "running", {});
      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("requires an idle session");
      expect(h.claims.list()).toHaveLength(0);
      expect(h.host.reservedCount).toBe(0);
    });

    it("initial handoff issues a --session-id identity and discovers the file at exit", async () => {
      const h = harness;
      const sessionId = createSession(h); // fresh — no Pi identity yet
      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.handoff.newPiSessionId).toBeTruthy();
      expect(result.handoff.piSessionFile).toBeUndefined();
      const newId = result.handoff.newPiSessionId!;

      // Pi wrote the session file under the configured storage root during
      // the handoff (--session-dir layout: <root>/--<encoded-cwd>--/<ts>_<id>.jsonl)
      const encoded = `--${h.wsPath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      mkdirSync(join(h.root, encoded), { recursive: true });
      const sessionFile = join(h.root, encoded, `2026-08-13T00-00-00-000Z_${newId}.jsonl`);
      writeFileSync(sessionFile, JSON.stringify({ type: "session", id: newId }) + "\n", "utf-8");

      const ended = h.service.endNativeHandoff({ sessionId, leaseOwner: "tui:1", code: 0 });
      expect(ended.ok).toBe(true);
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("idle");
      expect(rec.piSessionId).toBe(newId);
      expect(rec.piSessionFile).toBe(sessionFile);
      expect(rec.resumeCapability).toBe("available");
      expect(h.claims.list()).toHaveLength(0);
    });

    it("initial handoff with no file written lands interrupted + session_missing", async () => {
      const h = harness;
      const sessionId = createSession(h);
      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(true);
      h.service.endNativeHandoff({ sessionId, leaseOwner: "tui:1", code: 0 });
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("interrupted");
      expect(rec.resumeCapability).toBe("session_missing");
      expect(h.claims.list()).toHaveLength(0);
    });

    it("a busy workspace claim reports busy and leaks nothing", async () => {
      const h = harness;
      const sessionId = createSession(h);
      h.claims.tryAcquireInTx({ canonicalPath: h.wsPath, ownerId: "worker-1", generation: 1, ownerKind: "standalone" });
      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("busy");
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("idle");
      expect(rec.runtimeGeneration).toBe(1);
      expect(h.claims.list()).toHaveLength(1); // only the worker's claim
      expect(h.host.reservedCount).toBe(0);    // slot released
    });

    it("rejects a handoff while a prior writer pid is still alive", async () => {
      const h = harness;
      const sessionId = createSession(h);
      h.store.casTransition(sessionId, "idle", "idle", { observedPid: process.pid });
      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("still running");
      expect(h.claims.list()).toHaveLength(0);
      expect(h.host.reservedCount).toBe(0);
    });

    it("self-heals a stale native handoff fence once the prior pid is gone", async () => {
      const h = harness;
      const sessionId = createSession(h);
      const savedFile = writeSession(h.root, "stale.jsonl", "sess-1");
      // craft a crashed-handoff state: starting + native lease + claim, dead pid
      h.store.advanceGeneration(sessionId, 1, "resume");
      h.store.casTransition(sessionId, "idle", "starting", {
        piSessionId: "sess-1", piSessionFile: savedFile, observedPid: deadPid(),
      }, 2);
      h.store.setLease(sessionId, { frontend: "native-tui", owner: "tui:dead", generation: 2, acquiredAt: "2026-08-13" }, 2);
      h.claims.tryAcquireInTx({ canonicalPath: h.wsPath, ownerId: sessionId, generation: 2, ownerKind: "interactive" });

      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("starting");
      expect(rec.leaseOwner).toBe("tui:1");     // fresh lease
      expect(rec.leaseGeneration).toBe(3);       // new generation
      expect(h.claims.list()).toHaveLength(1);
      expect(h.claims.list()[0]!.generation).toBe(3); // stale claim released, fresh acquired
      expect(h.host.reservedCount).toBe(1);
    });

    it("abortNativeHandoff keeps the claim while the writer pid lives and releases when gone", async () => {
      const h = harness;
      const { sessionId } = await sessionWithIdentity(h);
      h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      // the client reported a live writer pid, then its connection died
      h.service.recordNativeHandoffPid({ sessionId, leaseOwner: "tui:1", pid: process.pid });
      h.service.abortNativeHandoff("tui:1");
      let rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("interrupted");
      expect(h.host.reservedCount).toBe(0);      // slot always released
      expect(h.claims.list()).toHaveLength(1);   // claim kept — orphan still writes
      expect(rec.leaseGeneration).not.toBeUndefined();

      // the orphan is gone (dead pid recorded now) — the next accept self-heals
      h.store.casTransition(sessionId, "interrupted", "interrupted", { observedPid: deadPid() });
      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:2", command: "/coding" });
      expect(result.ok).toBe(true);
      rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("starting");
      expect(rec.leaseOwner).toBe("tui:2");
      expect(h.claims.list()).toHaveLength(1);

      // the same abort path with a dead pid releases claim + lease entirely
      h.service.abortNativeHandoff("tui:2");
      rec = h.store.get(sessionId)!;
      expect(rec.leaseGeneration).toBeUndefined();
      expect(h.claims.list()).toHaveLength(0);
    });

    it("endNativeHandoff refuses a mismatched lease owner", async () => {
      const h = harness;
      const { sessionId } = await sessionWithIdentity(h);
      h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      const wrong = h.service.endNativeHandoff({ sessionId, leaseOwner: "tui:other", code: 0 });
      expect(wrong.ok).toBe(false);
      expect(wrong.message).toContain("lease owner");
      expect(h.claims.list()).toHaveLength(1);   // still held
      expect(h.host.reservedCount).toBe(1);
    });

    it("beginNativeHandoff resolves /coding new and /coding resume subcommands", async () => {
      const h = harness;
      const fresh = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding new repo-a" });
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      expect(fresh.handoff.newPiSessionId).toBeTruthy();
      expect(fresh.handoff.workspaceAlias).toBe("repo-a");
      const newSessionId = fresh.handoff.sessionId;
      h.service.endNativeHandoff({ sessionId: newSessionId, leaseOwner: "tui:1", code: 0 });

      const resumed = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:2", command: `/coding resume ${newSessionId}` });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.handoff.sessionId).toBe(newSessionId);
      h.service.endNativeHandoff({ sessionId: newSessionId, leaseOwner: "tui:2", code: 0 });
    });

    it("reconcileOnBoot keeps the native fence while the client-owned writer lives", async () => {
      const h = harness;
      const sessionId = createSession(h);
      const savedFile = writeSession(h.root, "t.jsonl", "sess-1");
      h.store.advanceGeneration(sessionId, 1, "resume");
      h.store.casTransition(sessionId, "idle", "starting", {
        piSessionId: "sess-1", piSessionFile: savedFile, observedPid: process.pid,
      }, 2);
      h.store.setLease(sessionId, { frontend: "native-tui", owner: "tui:9", generation: 2, acquiredAt: "2026-08-13" }, 2);
      h.claims.tryAcquireInTx({ canonicalPath: h.wsPath, ownerId: sessionId, generation: 2, ownerKind: "interactive" });

      h.service.reconcileOnBoot();
      const rec = h.store.get(sessionId)!;
      expect(rec.state).toBe("interrupted");
      // the client-owned Pi survives the bridge restart and may still write —
      // the claim and lease stay as the exclusive-writer fence
      expect(rec.leaseGeneration).toBe(2);
      expect(h.claims.list()).toHaveLength(1);

      // once the writer pid is gone, the next handoff accept self-heals
      h.store.casTransition(sessionId, "interrupted", "interrupted", { observedPid: deadPid() });
      const result = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding" });
      expect(result.ok).toBe(true);
      expect(h.claims.list()).toHaveLength(1);
      expect(h.claims.list()[0]!.generation).toBe(3);
    });

    it("unknown alias and unknown resume id are rejected before any process starts", () => {
      const h = harness;
      const badAlias = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding new nope" });
      expect(badAlias.ok).toBe(false);
      if (badAlias.ok) return;
      expect(badAlias.reason).toContain("Unknown workspace alias");
      const badResume = h.service.beginNativeHandoff({ ownerPrincipal: "usr-1", leaseOwner: "tui:1", command: "/coding resume spin-c-999" });
      expect(badResume.ok).toBe(false);
      expect(h.host.reservedCount).toBe(0);
      expect(h.claims.list()).toHaveLength(0);
    });
  });
});
