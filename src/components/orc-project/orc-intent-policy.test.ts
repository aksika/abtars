/**
 * orc-intent-policy.test.ts — #1680 intent-policy registry, tool-authorization
 * matrix, and the preserving orc_project_runs migration.
 *
 * #1792: only `operator_turn` survives — supervised entries, tool surfaces,
 * and completion-as-authority are deleted. The tool matrix is exercised at
 * BOTH real boundaries: schema presentation (createPiAgentTools) and
 * execution-time authorization (executeToolCall). Removing either consumer
 * must make the matrix fail.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let policyMod: typeof import("./orc-intent-policy.js");
let runStoreMod: typeof import("./orc-project-run-store.js");
let toolRegistry: typeof import("../transport/tool-registry.js");
let piCoreToolsMod: typeof import("../transport/pi-core-tools.js");
let piCoreSafetyMod: typeof import("../transport/pi-core-safety.js");
let fallbackPolicyMod: typeof import("../transport/fallback-policy.js");
let healthRegistryMod: typeof import("../transport/model-health-registry.js");

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-intent-policy-"));
  vi.doMock("../../paths.js", () => ({
    abtarsHome: () => TEST_HOME,
    abmindHome: () => join(TEST_HOME, "..", "abmind-test"),
    abtarsRoot: () => join(TEST_HOME, "live-checkout"),
  }));
  policyMod = await import("./orc-intent-policy.js");
  runStoreMod = await import("./orc-project-run-store.js");
  toolRegistry = await import("../transport/tool-registry.js");
  piCoreToolsMod = await import("../transport/pi-core-tools.js");
  piCoreSafetyMod = await import("../transport/pi-core-safety.js");
  fallbackPolicyMod = await import("../transport/fallback-policy.js");
  healthRegistryMod = await import("../transport/model-health-registry.js");
}, 30_000);

afterAll(() => {
  if (existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

function makeOrcContext(overrides: Partial<import("./orc-project-contracts.js").OrcInvocationContextV2> = {}): import("./orc-project-contracts.js").OrcInvocationContextV2 {
  return {
    version: 2,
    runId: "or_test_1",
    intentKey: "contract:1:1",
    intentKind: "operator_turn",
    projectCardId: 1,
    projectGeneration: 1,
    ownershipGeneration: 1,
    ownerPeer: "kp",
    ownerInstanceId: "inst",
    origin: { kind: "local" },
    ...overrides,
  };
}

function makeSafety() {
  return piCoreSafetyMod.createPiExecutionSafetyController(new fallbackPolicyMod.FallbackPolicy([] as never, new healthRegistryMod.ModelHealthRegistry()), undefined);
}

describe("#1680 intent policy rows (#1792: operator_turn only)", () => {
  it("carries the operator prompt bound and the full operator surface", () => {
    const policy = policyMod.intentPolicyFor("operator_turn");
    expect(policy.maxPromptRounds).toBe(25);
    expect(policy.allowedTools).toBe("operator_surface");
  });

  it("operator turns are always actionable and always complete", () => {
    const operator = policyMod.intentPolicyFor("operator_turn");
    expect(operator.isActionable(emptySnapshot())).toBe(true);
    expect(operator.isActionable({ ...emptySnapshot(), projectTerminal: true })).toBe(true);
    expect(operator.completion(emptySnapshot())).toEqual({ satisfied: true, code: "operator_turn_complete" });
  });

  it("deleted supervised kinds fail closed (#1792)", () => {
    const dead: Array<import("./orc-project-contracts.js").OrcIntentKind> = [
      "contract_authoring",
      "project_execution",
      "project_review",
      "repair_review",
      "input_resume",
    ];
    for (const kind of dead) {
      expect(() => policyMod.intentPolicyFor(kind)).toThrow();
      expect(() => policyMod.effectiveMaxPromptRounds(kind)).toThrow();
      expect(() => policyMod.orcAllowedToolsFor(kind)).toThrow();
      // The transport authorization gate denies without throwing so a
      // historical context degrades to denial, never a crash.
      expect(policyMod.orcToolAllowedOnIntent("execute_bash", kind)).toBe(false);
      expect(policyMod.orcToolAllowedOnIntent("define_project_contract", kind)).toBe(false);
    }
  });

  it("#1751 marks an owner read failure as incomplete evidence", () => {
    const db = {
      prepare: (sql: string) => ({
        get: () => {
          if (sql.includes("peer_contributions")) throw new Error("owner read unavailable");
          return undefined;
        },
      }),
    } as unknown as import("../tasks/kanban-board.js").TaskDatabase;

    const snapshot = policyMod.readOrcProjectSnapshot(db, 1);
    expect(snapshot.contributionActive).toBe(false);
    expect(snapshot.ownerReadsComplete).toBe(false);
  });

  it("operator completion is terminal output, independent of durable state", () => {
    const operator = policyMod.intentPolicyFor("operator_turn");
    expect(operator.completion(emptySnapshot()).satisfied).toBe(true);
    expect(operator.completion({ ...emptySnapshot(), projectTerminal: true }).satisfied).toBe(true);
  });
});

describe("#1789 hasAllLanesTerminal", () => {
  async function ensureStores(): Promise<import("./orc-project-run-store.js").OrcProjectRunStore> {
    // Mirror scheduled-synthesis.integration.test.ts: instantiate the stores so the
    // shared task database schema exists before any kanban write.
    const review = await import("../project-acceptance/project-review-store.js");
    void new review.ProjectReviewStore();
    const worker = await import("../worker-supervision-store.js");
    void new worker.WorkerSupervisionStore();
    return new runStoreMod.OrcProjectRunStore();
  }

  async function seedProject(statuses: string[]): Promise<number> {
    await ensureStores();
    const kanban = await import("../tasks/kanban-board.js");
    const root = kanban.kanbanEnqueue("1789 root", "task", undefined, { type: "O", goal: "g" }) as number;
    for (const [i, status] of statuses.entries()) {
      const child = kanban.kanbanEnqueue(`1789 lane ${i} ${status}`, "agent", undefined, { type: "W", parent_id: root }) as number;
      // Drive the lifecycle through the real transition helpers — never a raw
      // status write, so every state here is production-reachable by construction.
      if (status === "running") kanban.kanbanRunning(child);
      if (status === "done" || status === "delivering" || status === "delivered") {
        kanban.kanbanComplete(child, null, "lane summary");
      }
      if (status === "delivering" || status === "delivered") {
        expect(kanban.kanbanClaimDelivery(child)).toBe(true);
      }
      if (status === "delivered") kanban.kanbanMarkDelivered(child);
      if (status === "failed") kanban.kanbanFail(child, "lane failed");
    }
    return root;
  }

  function check(store: import("./orc-project-run-store.js").OrcProjectRunStore, root: number): boolean {
    return policyMod.hasAllLanesTerminal(store.db, root);
  }

  it("table-driven over the full CardStatus union: terminal set admits, anything else waits", async () => {
    // #1789 regression: `delivered` must be true (the shipped gate required transient
    // `done` and could never fire); `delivering` must be false (it waits, identically
    // at both layers).
    const cases: Array<[string, boolean]> = [
      ["queued", false],
      ["running", false],
      ["done", true],
      ["failed", true],
      ["delivering", false],
      ["delivered", true],
    ];
    for (const [status, expected] of cases) {
      const store = await ensureStores();
      expect(check(store, await seedProject([status])), `${status} → ${expected}`).toBe(expected);
    }
    // Mixed rows: one non-terminal lane anywhere blocks.
    expect(check(await ensureStores(), await seedProject(["delivered", "delivered", "running"]))).toBe(false);
    expect(check(await ensureStores(), await seedProject(["delivered", "delivering"]))).toBe(false);
    // Failed originals are terminal: a repaired set passes with no coverage machinery.
    expect(check(await ensureStores(), await seedProject(["failed", "failed", "delivered", "delivered"]))).toBe(true);
  });

  it("zero children → false (#1789: no handoff misread on an unspawned project)", async () => {
    // Guard against the rejected hasNoWorkingLanes shape (COUNT(queued|running) == 0
    // is true for zero children): a turn that spawned nothing must report
    // false here, never a terminal lane set.
    const kanban = await import("../tasks/kanban-board.js");
    const root = kanban.kanbanEnqueue("1789 childless root", "task", undefined, { type: "O", goal: "g" }) as number;
    expect(check(await ensureStores(), root)).toBe(false);
  });
});

function emptySnapshot(): import("./orc-intent-policy.js").OrcProjectSnapshot {
  return {
    supervisionState: null,
    supervisionGeneration: null,
    contractExists: false,
    projectTerminal: false,
    contributionActive: false,
    openReviewCase: false,
    inputRequestsOutstanding: false,
    ownerReadsComplete: true,
    workerOwnedChild: false,
    allLanesTerminal: false,
  };
}

describe("#1792 operator prompt bound (fixed; review escalation deleted)", () => {
  it("operator_turn is always 25 and ignores the dispatch ordinal", () => {
    expect(policyMod.effectiveMaxPromptRounds("operator_turn")).toBe(25);
    expect(policyMod.effectiveMaxPromptRounds("operator_turn", 1)).toBe(25);
    expect(policyMod.effectiveMaxPromptRounds("operator_turn", 3)).toBe(25);
    expect(policyMod.effectiveMaxPromptRounds("operator_turn", 99)).toBe(25);
  });
});

describe("#1680 tool authorization matrix (schema + execution boundaries; #1792: operator surface only)", () => {
  // #1792: the supervised Orc tools (define_project_contract, spawn_worker,
  // review_project, yield_turn) are deleted from the registry — only a live
  // tool can pin the matrix at both boundaries now.
  const MATRIX: Array<[import("./orc-project-contracts.js").OrcIntentKind, string, boolean]> = [
    // operator turns retain the full surface
    ["operator_turn", "execute_bash", true],
  ];

  it("schema presentation filters by the exact policy surface", () => {
    for (const [kind, toolName, allowed] of MATRIX) {
      const tools = piCoreToolsMod.createPiAgentTools({
        executionId: "exec_1",
        userId: "u",
        sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
        safety: makeSafety(),
        orcContext: makeOrcContext({ intentKind: kind }),
      } as never);
      expect(tools.some((t) => t.name === toolName), `${kind} schema for ${toolName}`).toBe(allowed);
    }
  });

  it("execution-time authorization rejects forged calls with the same policy", async () => {
    for (const [kind, toolName, allowed] of MATRIX) {
      const result = await toolRegistry.executeToolCall(toolName, {}, {
        userId: "u",
        orcContext: makeOrcContext({ intentKind: kind }),
        authorizationMode: "interactive",
      });
      if (allowed) {
        // The tool exists and ran (or produced a typed args error) — never the
        // intent-surface denial.
        expect(result.includes("orc_intent_surface"), `${kind} exec ${toolName}`).toBe(false);
      } else {
        const parsed = JSON.parse(result) as { reason?: string };
        expect(parsed.reason, `${kind} exec ${toolName}`).toBe("orc_intent_surface");
      }
    }
  });

  it("a project-bound turn without an intent kind fails closed", async () => {
    const tools = piCoreToolsMod.createPiAgentTools({
      executionId: "exec_1",
      userId: "u",
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      safety: makeSafety(),
      orcContext: { ...makeOrcContext(), intentKind: undefined as never },
    } as never);
    expect(tools).toHaveLength(0);
    const result = await toolRegistry.executeToolCall("define_project_contract", {}, {
      userId: "u", orcContext: { ...makeOrcContext(), intentKind: undefined as never }, authorizationMode: "interactive",
    });
    expect(JSON.parse(result)).toMatchObject({ reason: "orc_intent_surface" });
  });
});

describe("#1680 preserving orc_project_runs intent migration", () => {
  let db: import("better-sqlite3").Database;

  beforeEach(async () => {
    const { resolveNativeDep } = await import("../../utils/lazy-require.js") as { resolveNativeDep: (name: string) => unknown };
    const Database = resolveNativeDep("better-sqlite3") as { new (file: string): import("better-sqlite3").Database };
    db = new Database(":memory:");
  });

  function createOldSchema(rows: Array<Record<string, unknown>>): void {
    db.exec(`
      CREATE TABLE orc_project_runs (
        id                    TEXT PRIMARY KEY,
        intent_key            TEXT NOT NULL,
        intent_kind           TEXT NOT NULL
                                CHECK(intent_kind IN
                                  ('contract_authoring','project_review',
                                   'repair_review','input_resume','operator_turn')),
        intent_ref            TEXT,
        goal                  TEXT NOT NULL,
        project_card_id       INTEGER NOT NULL,
        project_generation    INTEGER NOT NULL,
        ownership_generation  INTEGER NOT NULL,
        global_slot           INTEGER NOT NULL DEFAULT 1 CHECK(global_slot = 1),
        owner_peer            TEXT NOT NULL,
        owner_instance_id     TEXT NOT NULL,
        origin_kind           TEXT NOT NULL CHECK(origin_kind IN ('local','peer')),
        origin_peer           TEXT,
        session_id            TEXT,
        execution_id          TEXT,
        state                 TEXT NOT NULL
                                CHECK(state IN
                                  ('scheduled','dispatching','running',
                                   'released','superseded')),
        outcome               TEXT,
        failure_code          TEXT,
        created_at            TEXT NOT NULL,
        started_at            TEXT,
        released_at           TEXT,
        updated_at            TEXT NOT NULL,
        UNIQUE(project_card_id, ownership_generation),
        UNIQUE(project_card_id, intent_key, ownership_generation)
      );
      CREATE UNIQUE INDEX idx_one_live_orc_run_per_project
        ON orc_project_runs(project_card_id)
        WHERE state IN ('scheduled','dispatching','running');
      CREATE UNIQUE INDEX idx_one_global_orc_turn
        ON orc_project_runs(global_slot)
        WHERE state IN ('dispatching','running');
      CREATE TABLE orc_project_ownership_counters (
        project_card_id INTEGER PRIMARY KEY,
        next_generation INTEGER NOT NULL
      );
    `);
    const stmt = db.prepare(`
      INSERT INTO orc_project_runs
        (id, intent_key, intent_kind, intent_ref, goal, project_card_id,
         project_generation, ownership_generation, global_slot, owner_peer,
         owner_instance_id, origin_kind, origin_peer, session_id, execution_id,
         state, outcome, failure_code, created_at, started_at, released_at, updated_at)
      VALUES (@id, @intent_key, @intent_kind, NULL, 'seeded', @project_card_id,
              @project_generation, @ownership_generation, 1, 'kp', 'inst', 'local', NULL,
              NULL, NULL, @state, @outcome, NULL, @created_at, NULL, NULL, @created_at)
    `);
    for (const row of rows) stmt.run(row);
  }

  function wrapDb(): import("./orc-project-run-store.js").OrcProjectRunStore {
    return new runStoreMod.OrcProjectRunStore({
      prepare: (sql: string) => db.prepare(sql),
      exec: (sql: string) => db.exec(sql),
      pragma: (p: string) => db.pragma(p),
      transaction: (fn: () => unknown) => db.transaction(fn)(),
      transactionImmediate: (fn: () => unknown) => db.transaction(fn)(),
    } as never);
  }

  it("preserves historical terminal and live rows, admits project_execution, keeps both uniqueness indexes, and is idempotent", () => {
    createOldSchema([
      { id: "or_terminal_1", intent_key: "contract:1:1", intent_kind: "contract_authoring", project_card_id: 1, project_generation: 1, ownership_generation: 1, state: "released", outcome: "completed", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "or_live_1", intent_key: "contract:2:1", intent_kind: "contract_authoring", project_card_id: 2, project_generation: 1, ownership_generation: 1, state: "running", outcome: null, created_at: "2026-08-01T00:00:00.000Z" },
    ]);
    const store = wrapDb();
    store.migrate();
    store.migrate(); // idempotent reopen

    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orc_project_runs'`).get() as { sql: string };
    expect(sql.sql).toContain("'project_execution'");
    const rows = db.prepare(`SELECT id, intent_kind, state FROM orc_project_runs ORDER BY id`).all() as Array<{ id: string; intent_kind: string; state: string }>;
    expect(rows).toEqual([
      { id: "or_live_1", intent_kind: "contract_authoring", state: "running" },
      { id: "or_terminal_1", intent_kind: "contract_authoring", state: "released" },
    ]);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_one_live_orc_run_per_project','idx_one_global_orc_turn')`).all() as Array<{ name: string }>;
    expect(indexes.map(i => i.name).sort()).toEqual(["idx_one_global_orc_turn", "idx_one_live_orc_run_per_project"]);

    // The new intent is admitted and unknown kinds are still rejected.
    db.prepare(`
      INSERT INTO orc_project_runs
        (id, intent_key, intent_kind, goal, project_card_id, project_generation,
         ownership_generation, owner_peer, owner_instance_id, origin_kind, state, created_at, updated_at)
      VALUES ('or_exec_1', 'execute:3:1', 'project_execution', 'g', 3, 1, 1, 'kp', 'inst', 'local', 'scheduled', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());
    expect(() => db.prepare(`
      INSERT INTO orc_project_runs
        (id, intent_key, intent_kind, goal, project_card_id, project_generation,
         ownership_generation, owner_peer, owner_instance_id, origin_kind, state, created_at, updated_at)
      VALUES ('or_bad_1', 'execute:4:1', 'not_an_intent', 'g', 4, 1, 1, 'kp', 'inst', 'local', 'scheduled', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString())).toThrow();

    // Both live-run uniqueness fences survive the rebuild.
    expect(() => db.prepare(`
      INSERT INTO orc_project_runs
        (id, intent_key, intent_kind, goal, project_card_id, project_generation,
         ownership_generation, owner_peer, owner_instance_id, origin_kind, state, created_at, updated_at)
      VALUES ('or_live2_1', 'execute:2:2', 'project_execution', 'g', 2, 2, 2, 'kp', 'inst', 'local', 'running', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString())).toThrow();
  });
});
