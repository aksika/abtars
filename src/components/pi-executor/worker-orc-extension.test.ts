/**
 * worker-orc-extension.test.ts — #1643: supervised-only extension loading.
 *
 * Proves:
 *   - the secure resolver admits only the canonical regular file below
 *     abtarsRoot()/templates/pi-extensions (rejects symlinks and a missing
 *     artifact);
 *   - PiRuntimeHost.launch appends owned --extension pairs before --mode rpc
 *     and fails BEFORE spawn for a missing/unreadable artifact;
 *   - PiExecutor passes the canonical extension path ONLY for supervised
 *     origins — standalone /pi run consumers keep their exact argument
 *     vector; and
 *   - a supervised run with a missing artifact settles failed through the
 *     existing start-failure path with no process, no slot, and no claim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { PiRunStore } from "./pi-run-store.js";
import { PiExecutor } from "./pi-executor.js";
import type { PiExecutorConfig } from "./config.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { ensureKanbanBoardSchema } from "../tasks/kanban-board.js";
import { PiRuntimeHost } from "./pi-runtime-host.js";
import {
  resolveWorkerOrcExtensionPath,
  WORKER_ORC_EXTENSION_FILE,
  WORKER_ORC_EXTENSION_PROTOCOL,
} from "./worker-orc-extension.js";

// ── controllable RPC fake (module-mocked into ./pi-rpc-client.js) ───────────

const fake = vi.hoisted(() => {
  type Call = { method: string; args: unknown[] };
  class FakeClient {
    static instances: FakeClient[] = [];
    static getStateError: Error | null = null;
    pid = 4242;
    closed = false;
    calls: Call[] = [];
    private termCbs = new Set<(e: unknown) => void>();
    private subCbs = new Set<(e: unknown) => void>();
    private uiCbs = new Set<(e: unknown) => void>();
    constructor() { FakeClient.instances.push(this); }
    record(method: string, args: unknown[] = []): void { this.calls.push({ method, args }); }
    async launch(...args: unknown[]): Promise<void> { this.record("launch", args); }
    async getState(): Promise<{ sessionId: string; sessionFile?: string; isStreaming: boolean; isCompacting: boolean }> {
      this.record("getState");
      if (FakeClient.getStateError) throw FakeClient.getStateError;
      return { sessionId: "fresh-process", sessionFile: undefined, isStreaming: false, isCompacting: false };
    }
    async getAvailableModels(): Promise<Array<{ id: string }>> { return [{ id: "model-x" }]; }
    async setModel(...args: unknown[]): Promise<void> { this.record("setModel", args); }
    async prompt(text: string): Promise<void> { this.record("prompt", [text]); }
    async followUp(text: string): Promise<void> { this.record("followUp", [text]); }
    async switchSession(file: string): Promise<{ cancelled: boolean }> { this.record("switchSession", [file]); return { cancelled: false }; }
    async steer(...args: unknown[]): Promise<void> { this.record("steer", args); }
    async respondToUi(...args: unknown[]): Promise<{ ok: boolean }> { this.record("respondToUi", args); return { ok: true }; }
    async abort(): Promise<void> { this.record("abort"); }
    async close(): Promise<void> { this.record("close"); this.closed = true; }
    onTermination(cb: (e: unknown) => void): () => void { this.termCbs.add(cb); return () => this.termCbs.delete(cb); }
    subscribe(cb: (e: unknown) => void): () => void { this.subCbs.add(cb); return () => this.subCbs.delete(cb); }
    onUiRequest(cb: (e: unknown) => void): () => void { this.uiCbs.add(cb); return () => this.uiCbs.delete(cb); }
    static reset(): void {
      FakeClient.instances = [];
      FakeClient.getStateError = null;
    }
  }
  class PiRpcError extends Error { code = "unknown"; }
  return { FakeClient, PiRpcError };
});

vi.mock("./pi-rpc-client.js", () => ({
  SupervisedPiRpcClient: fake.FakeClient,
  PiRpcError: fake.PiRpcError,
}));

const _require = createRequire(import.meta.url);
const Database: typeof import("better-sqlite3") = _require(join(homedir(), ".local", "lib", "node_modules", "better-sqlite3"));

function createTestDb(): TaskDatabase {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  // #1631: the production board schema helper — the fixture can never drift.
  ensureKanbanBoardSchema(raw);
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

const SAVED_ABTARS_ROOT = process.env.ABTARS_ROOT;

afterEach(() => {
  fake.FakeClient.reset();
  if (SAVED_ABTARS_ROOT === undefined) delete process.env.ABTARS_ROOT;
  else process.env.ABTARS_ROOT = SAVED_ABTARS_ROOT;
});

function makeConfig(wsPath: string): PiExecutorConfig {
  return {
    enabled: true, command: "fake-pi", fixedArgs: ["--some-fixed-flag"],
    workspaceAliases: { "repo-a": { path: wsPath } },
    allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000,
    projectTrust: "never", sessionStorageRoot: wsPath,
  };
}

describe("resolveWorkerOrcExtensionPath (#1643)", () => {
  it("resolves the canonical regular artifact in the active release", () => {
    const resolved = resolveWorkerOrcExtensionPath();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.path).toContain(join("templates", "pi-extensions", WORKER_ORC_EXTENSION_FILE));
      expect(resolved.path.endsWith(WORKER_ORC_EXTENSION_FILE)).toBe(true);
    }
  });

  it("fails with the versioned artifact name when the file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "worc-missing-"));
    mkdirSync(join(root, "templates", "pi-extensions"), { recursive: true });
    process.env.ABTARS_ROOT = root;
    const resolved = resolveWorkerOrcExtensionPath();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain(WORKER_ORC_EXTENSION_FILE);
      expect(resolved.error).not.toContain(root);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a symlink artifact instead of following it", () => {
    const root = mkdtempSync(join(tmpdir(), "worc-symlink-"));
    const extDir = join(root, "templates", "pi-extensions");
    mkdirSync(extDir, { recursive: true });
    const outside = join(root, "outside.ts");
    writeFileSync(outside, "export default () => {};\n", "utf-8");
    symlinkSync(outside, join(extDir, WORKER_ORC_EXTENSION_FILE));
    process.env.ABTARS_ROOT = root;
    const resolved = resolveWorkerOrcExtensionPath();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("symlink");
    rmSync(root, { recursive: true, force: true });
  });

  it("exports the versioned protocol/file contract constants", () => {
    expect(WORKER_ORC_EXTENSION_PROTOCOL).toBe(1);
    expect(WORKER_ORC_EXTENSION_FILE).toBe("worker-orc-v1.ts");
  });
});

describe("worker-orc-v1.ts packaging (#1643)", () => {
  it("ships in the npm package files list", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf-8")) as { files?: string[] };
    expect(pkg.files ?? []).toContain("templates/");
  });

  it("resolves the artifact from a staged release tree (emergency-update cp -a templates → release)", () => {
    const { mkdirSync, cpSync } = require("node:fs") as typeof import("node:fs");
    const staged = mkdtempSync(join(tmpdir(), "worc-staged-"));
    // Exactly what scripts/emergency-update.sh does: the whole templates dir
    // is copied into the staged release root.
    cpSync(join(__dirname, "..", "..", "..", "templates"), join(staged, "templates"), { recursive: true });
    process.env.ABTARS_ROOT = staged;
    const resolved = resolveWorkerOrcExtensionPath();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.path.startsWith(join(staged, "templates"))).toBe(true);
      expect(existsSync(resolved.path)).toBe(true);
    }
    rmSync(staged, { recursive: true, force: true });
  });

  it("resolves the artifact in source/npm-package layout (abtarsRoot fallback)", () => {
    delete process.env.ABTARS_ROOT;
    const resolved = resolveWorkerOrcExtensionPath();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(existsSync(resolved.path)).toBe(true);
  });
});

describe("PiRuntimeHost.launch extensionPaths (#1643)", () => {
  it("appends one owned --extension pair per path before --mode rpc, preserving trust/fixed ordering", async () => {
    const root = mkdtempSync(join(tmpdir(), "worc-host-"));
    const wsPath = join(root, "ws");
    mkdirSync(wsPath, { recursive: true });
    const ext = join(root, "ext.ts");
    writeFileSync(ext, "export default () => {};\n", "utf-8");
    const host = new PiRuntimeHost(makeConfig(wsPath));
    const outcome = await host.launch({
      workspaceAlias: "repo-a",
      envIdentity: { id: "r1", ownerPrincipalId: "u", executionGeneration: 1 },
      extensionPaths: [ext],
    });
    expect(outcome.ok).toBe(true);
    const client = fake.FakeClient.instances[0]!;
    const launch = client.calls.find(c => c.method === "launch")!;
    const args = launch.args[1] as string[];
    const modeIdx = args.indexOf("--mode");
    expect(args.slice(0, modeIdx)).toEqual(["--some-fixed-flag", "--extension", ext]);
    expect(args[modeIdx + 1]).toBe("rpc");
    expect(args[modeIdx + 2]).toBe("--no-approve");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails BEFORE spawn when an extension artifact is missing or unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "worc-host-"));
    const wsPath = join(root, "ws");
    mkdirSync(wsPath, { recursive: true });
    const host = new PiRuntimeHost(makeConfig(wsPath));
    const outcome = await host.launch({
      workspaceAlias: "repo-a",
      envIdentity: { id: "r1", ownerPrincipalId: "u", executionGeneration: 1 },
      extensionPaths: [join(root, "nope", "ext.ts")],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("Extension artifact");
      expect(outcome.error).toContain("ext.ts");
      expect(outcome.error).not.toContain(root);
    }
    expect(fake.FakeClient.instances).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("PiExecutor supervised-only extension loading (#1643)", () => {
  function makeExecutor(wsPath: string) {
    const db = createTestDb();
    const store = new PiRunStore({ db, sessionStorageRoot: wsPath });
    const executor = new PiExecutor(makeConfig(wsPath), store);
    return { store, executor };
  }

  function seedRun(store: PiRunStore, origin: "user" | "supervised", wsPath: string, alias = "repo-a"): { runId: string; cardId: number } {
    const created = store.createPiCardAndRun({
      runId: store.generateId(), sessionId: "c-1", title: "Pi run",
      goal: "do the thing", workspaceAlias: alias, ownerPrincipalId: "usr-1", origin,
    });
    const claim = store.claimQueuedGeneration(created.cardId, wsPath);
    if (!claim.claimed) throw new Error("claim failed");
    return { runId: created.runId, cardId: created.cardId };
  }

  it("passes the canonical extension path only for supervised origins", async () => {
    const root = mkdtempSync(join(tmpdir(), "worc-exec-"));
    const supWs = join(root, "ws-sup");
    const stdWs = join(root, "ws-std");
    mkdirSync(supWs, { recursive: true });
    mkdirSync(stdWs, { recursive: true });
    const db = createTestDb();
    const store = new PiRunStore({ db, sessionStorageRoot: root });
    const executor = new PiExecutor({
      ...makeConfig(supWs),
      workspaceAliases: { "repo-a": { path: supWs }, "repo-b": { path: stdWs } },
      maxConcurrent: 2,
    }, store);
    const supervised = seedRun(store, "supervised", supWs, "repo-a");
    const standalone = seedRun(store, "user", stdWs, "repo-b");
    const resolved = resolveWorkerOrcExtensionPath();
    if (!resolved.ok) throw new Error(`artifact must resolve: ${resolved.error}`);

    const supResult = await executor.startWithClaim(supervised.runId, store.get(supervised.runId)!.executionGeneration, "s-sup");
    expect(supResult).toBe("started");
    const supClient = fake.FakeClient.instances[0]!;
    const supArgs = supClient.calls.find(c => c.method === "launch")!.args[1] as string[];
    expect(supArgs).toContain("--extension");
    expect(supArgs).toContain(resolved.path);
    expect(supArgs.indexOf("--extension") < supArgs.indexOf("--mode")).toBe(true);

    const standResult = await executor.startWithClaim(standalone.runId, store.get(standalone.runId)!.executionGeneration, "s-std");
    expect(standResult).toBe("started");
    const stdClient = fake.FakeClient.instances[1]!;
    const stdArgs = stdClient.calls.find(c => c.method === "launch")!.args[1] as string[];
    expect(stdArgs).not.toContain("--extension");
    // Fixed/trust/mode ordering unchanged for every other consumer.
    expect(stdArgs.indexOf("--some-fixed-flag") < stdArgs.indexOf("--mode")).toBe(true);
    expect(stdArgs[stdArgs.indexOf("--mode") + 1]).toBe("rpc");
    rmSync(root, { recursive: true, force: true });
  });

  it("a supervised run with a missing artifact settles failed through the coordinator: no spawn, no slot, no claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "worc-exec-"));
    const wsPath = join(root, "ws");
    mkdirSync(wsPath, { recursive: true });
    const db = createTestDb();
    const store = new PiRunStore({ db, sessionStorageRoot: wsPath });
    const config = makeConfig(wsPath);
    const executor = new PiExecutor(config, store);

    // Real supervised binding (same shape as supervised-pi-settlement.test):
    // root O card, W child, contract, attempt, workspace claim, Pi binding.
    const now = new Date().toISOString();
    const workerStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore(db);
    db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, created_at, updated_at) VALUES (?, ?, 't', 'running', 'O', ?, ?)`).run(900, "proj", now, now);
    db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, 't', 'queued', 'W', ?, ?, ?)`).run(901, "child", 900, now, now);
    workerStore.insertContract({ schema_version: 1, id: "c_sup", digest: "d", goal: "g", criteria: [{ id: "c1", description: "d" }], expected_artifacts: [{ id: "a1", kind: "file", ref: "out.md", required: true, criterion_ids: ["c1"] }], verification_commands: [{ id: "v1", argv: ["true"], timeout_ms: 5000, criterion_ids: ["c1"] }], required_capabilities: [], limits: {}, provenance: { root_card_id: 900, card_id: 901, authored_by: "t", created_at: now } }, 901);
    workerStore.insertAttempt({ id: "a_sup", card_id: 901, contract_id: "c_sup", ordinal: 1, executor_kind: "pi", executor_id: "pi-coding", status: "pending", started_at: now });
    workerStore.lifecycleTransition("a_sup", ["pending"], "claimed");
    workerStore.lifecycleTransition("a_sup", ["claimed"], "starting");
    const run = store.createSupervisedRun({ cardId: 901, workspaceAlias: "repo-a", goal: "g", ownerPrincipalId: "p", sessionId: "s" });
    const wsClaim = store.claimSupervisedGeneration({ runId: run.runId, expectedGeneration: run.generation, canonicalPath: wsPath });
    if (wsClaim.kind !== "claimed") throw new Error(`workspace claim failed: ${wsClaim.kind}`);
    workerStore.bindExecutorResource({ attemptId: "a_sup", expectedAttemptGeneration: 1, executorKind: "pi", resourceId: run.runId, resourceGeneration: run.generation, continuity: "initial" });

    const { SupervisedPiSettlement } = await import("./supervised-pi-settlement.js");
    executor.setSettlementRouter((obs) => new SupervisedPiSettlement(store, workerStore, config).settlePiExecution(obs));

    const emptyRoot = mkdtempSync(join(tmpdir(), "worc-empty-"));
    process.env.ABTARS_ROOT = emptyRoot;

    const result = await executor.startWithClaim(run.runId, run.generation, "s-miss");
    expect(result).toBe("error");
    const runRow = store.get(run.runId)!;
    expect(runRow.status).toBe("failed");
    expect(String(runRow.error ?? "")).toContain("worker-orc-v1.ts");
    const attempt = workerStore.getAttempt("a_sup")!;
    expect(attempt.lifecycle).toBe("failed");
    expect(executor.host.reservedCount).toBe(0);
    expect(store.listWorkspaceClaims()).toHaveLength(0);
    expect(fake.FakeClient.instances).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyRoot, { recursive: true, force: true });
  });
});
