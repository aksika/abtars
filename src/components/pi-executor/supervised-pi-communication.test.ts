/**
 * supervised-pi-communication.test.ts — #1643: typed tell_orc routing.
 *
 * Real SQLite (the kanban-board module's own kanban.db under a tmp home)
 * shared by PiRunStore, WorkerSupervisionStore, and the channel. Proves:
 *   - a valid supervised tell_orc posts exactly once to the ROOT card with
 *     typed Worker provenance, zero directive, progress type, and the exact
 *     source reference;
 *   - duplicate RPC delivery posts/fires exactly once;
 *   - malformed args, stale Pi generation, terminal attempt, non-supervised
 *     origin, wrong card lineage, and unrelated tool events are ignored with
 *     no host mutation; and
 *   - channel unavailability propagates as "unavailable" without throwing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRunStore } from "./pi-run-store.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { SupervisedPiCommunication } from "./supervised-pi-communication.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

let TEST_HOME: string;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "sup-pi-comm-"));
  process.env["ABTARS_HOME"] = TEST_HOME;
});

afterAll(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

/** Boot the canonical kanban module DB (file DB under TEST_HOME). */
async function bootDb(): Promise<TaskDatabase> {
  const { requireTaskDatabase } = await import("../tasks/kanban-board.js");
  return requireTaskDatabase();
}

interface Fixture {
  piStore: PiRunStore;
  workerStore: WorkerSupervisionStore;
  port: SupervisedPiCommunication;
  rootCardId: number;
  childCardId: number;
  attemptId: string;
  runId: string;
  generation: number;
  channel: typeof import("../tasks/kanban-channel.js");
}

let fixtureSeq = 0;

async function makeFixture(opts?: { origin?: "supervised" | "user"; childType?: string }): Promise<Fixture> {
  const db = await bootDb();
  const piStore = new PiRunStore({ db, sessionStorageRoot: join(TEST_HOME, "sessions") });
  const workerStore = new WorkerSupervisionStore(db);
  const channel = await import("../tasks/kanban-channel.js");
  const now = new Date().toISOString();
  fixtureSeq += 1;
  const rootCardId = 20000 + fixtureSeq * 10;
  const childCardId = rootCardId + 1;
  db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, created_at, updated_at) VALUES (?, ?, 't', 'running', 'O', ?, ?)`).run(rootCardId, "proj", now, now);
  db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, 't', 'queued', ?, ?, ?, ?)`).run(childCardId, "child", opts?.childType ?? "W", rootCardId, now, now);

  const run = piStore.createSupervisedRun({ cardId: childCardId, workspaceAlias: "repo-a", goal: "g", ownerPrincipalId: "p", sessionId: "s" });
  if (opts?.origin === "user") {
    // A user-origin standalone run on the same child card for the negative case.
    db.prepare(`UPDATE pi_runs SET origin = 'user' WHERE id = ?`).run(run.runId);
  }
  if (opts?.childType && opts.childType !== "W") {
    // Wrong lineage: no contract/attempt for the non-W card.
    return { piStore, workerStore, port: new SupervisedPiCommunication(piStore, workerStore), rootCardId, childCardId, attemptId: "", runId: run.runId, generation: run.generation, channel };
  }
  workerStore.insertContract({ schema_version: 1, id: `c_comm_${fixtureSeq}`, digest: "d", goal: "g", criteria: [{ id: "c1", description: "d" }], expected_artifacts: [], verification_commands: [], required_capabilities: [], limits: {}, provenance: { root_card_id: rootCardId, card_id: childCardId, authored_by: "t", created_at: now } }, childCardId);
  const attemptId = `a_comm_${fixtureSeq}`;
  workerStore.insertAttempt({ id: attemptId, card_id: childCardId, contract_id: "c_comm", ordinal: 1, executor_kind: "pi", executor_id: "pi-coding", status: "pending", started_at: now });
  workerStore.lifecycleTransition(attemptId, ["pending"], "claimed");
  workerStore.lifecycleTransition(attemptId, ["claimed"], "starting");
  const ws = join(TEST_HOME, "ws", String(fixtureSeq));
  const claim = piStore.claimSupervisedGeneration({ runId: run.runId, expectedGeneration: run.generation, canonicalPath: ws });
  if (claim.kind !== "claimed") throw new Error(`claim failed: ${claim.kind}`);
  workerStore.bindExecutorResource({ attemptId, expectedAttemptGeneration: 1, executorKind: "pi", resourceId: run.runId, resourceGeneration: run.generation, continuity: "initial" });
  workerStore.lifecycleTransition(attemptId, ["starting"], "running");
  return {
    piStore, workerStore, port: new SupervisedPiCommunication(piStore, workerStore),
    rootCardId, childCardId, attemptId, runId: run.runId, generation: run.generation, channel,
  };
}

function tellStart(fx: Fixture, overrides: Partial<{ runId: string; piGeneration: number; toolCallId: string; toolName: string; args: unknown }> = {}) {
  return {
    runId: fx.runId,
    piGeneration: fx.generation,
    toolCallId: "tc-1",
    toolName: "tell_orc",
    args: { message: "Found the root cause in the config loader." },
    ...overrides,
  };
}

describe("SupervisedPiCommunication (#1643)", () => {
  it("posts exactly one root-card row with typed provenance and the exact source reference", async () => {
    const fx = await makeFixture();
    const outcome = fx.port.onToolStart(tellStart(fx));
    expect(outcome).toBe("posted");
    const rows = fx.channel.channelRead(fx.rootCardId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_agent).toBe(`Worker:${fx.childCardId}`);
    expect(rows[0]!.to_agent).toBe("Orc");
    expect(rows[0]!.directive).toBe(0);
    expect(rows[0]!.msg_type).toBe("progress");
    expect(rows[0]!.source_ref).toBe(`pi-orc:v1:${fx.runId}:${fx.generation}:tc-1`);
    expect(rows[0]!.message).toBe("Found the root cause in the config loader.");
    // The child card itself received nothing.
    expect(fx.channel.channelRead(fx.childCardId)).toHaveLength(0);
  });

  it("a replayed duplicate delivery posts and fires exactly once", async () => {
    const fx = await makeFixture();
    expect(fx.port.onToolStart(tellStart(fx))).toBe("posted");
    expect(fx.port.onToolStart(tellStart(fx))).toBe("duplicate");
    expect(fx.channel.channelRead(fx.rootCardId)).toHaveLength(1);
  });

  it("ignores malformed arguments with no host mutation", async () => {
    const fx = await makeFixture();
    const cases: Array<Partial<{ args: unknown }>> = [
      { args: {} },
      { args: { message: 42 } },
      { args: { message: "" } },
      { args: { message: "   " } },
      { args: { message: "x".repeat(1001) } },
      { args: null },
    ];
    for (const c of cases) {
      expect(fx.port.onToolStart(tellStart(fx, c))).toBe("ignored");
    }
    expect(fx.channel.channelRead(fx.rootCardId)).toHaveLength(0);
  });

  it("ignores stale Pi generations and non-supervised origins", async () => {
    const fx = await makeFixture();
    expect(fx.port.onToolStart(tellStart(fx, { piGeneration: fx.generation + 1 }))).toBe("ignored");
    const user = await makeFixture({ origin: "user" });
    expect(user.port.onToolStart(tellStart(user))).toBe("ignored");
    expect(fx.channel.channelRead(fx.rootCardId)).toHaveLength(0);
  });

  it("ignores an event whose Worker attempt is already terminal", async () => {
    const fx = await makeFixture();
    fx.workerStore.failAttempt(fx.attemptId);
    expect(fx.port.onToolStart(tellStart(fx))).toBe("ignored");
    expect(fx.channel.channelRead(fx.rootCardId)).toHaveLength(0);
  });

  it("ignores a wrong card lineage and unrelated tool names", async () => {
    const badLineage = await makeFixture({ childType: "T" });
    expect(badLineage.port.onToolStart(tellStart(badLineage))).toBe("ignored");
    const fx = await makeFixture();
    expect(fx.port.onToolStart(tellStart(fx, { toolName: "ask_orc" }))).toBe("ignored");
    expect(fx.port.onToolStart(tellStart(fx, { toolName: "bash" }))).toBe("ignored");
    expect(fx.channel.channelRead(fx.rootCardId)).toHaveLength(0);
  });

  it("propagates channel unavailability without throwing", async () => {
    const fx = await makeFixture();
    const spy = vi.spyOn(fx.channel, "channelPostOnce").mockReturnValue("unavailable" as const);
    expect(fx.port.onToolStart(tellStart(fx))).toBe("unavailable");
    spy.mockRestore();
  });

  it("never throws into the Pi event loop for any malformed frame", async () => {
    const fx = await makeFixture();
    expect(fx.port.onToolStart({ runId: "", piGeneration: 0, toolCallId: "", toolName: "tell_orc", args: { message: 1 } })).toBe("ignored");
    expect(fx.port.onToolStart({ runId: "missing-run", piGeneration: 1, toolCallId: "x", toolName: "tell_orc", args: { message: "hi" } })).toBe("ignored");
  });
});
