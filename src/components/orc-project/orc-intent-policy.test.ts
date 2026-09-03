/**
 * orc-intent-policy.test.ts — #1680 intent-policy registry, tool-authorization
 * matrix, and the preserving orc_project_runs migration.
 *
 * The tool matrix is exercised at BOTH real boundaries: schema presentation
 * (createPiAgentTools) and execution-time authorization (executeToolCall).
 * Removing either consumer must make the matrix fail.
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
    intentKind: "contract_authoring",
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

describe("#1680 intent policy rows", () => {
  it("carries the exact intent prompt bounds and tool surfaces (#1725: review/input bound is 6)", () => {
    const cases: Array<[import("./orc-project-contracts.js").OrcIntentKind, number, string]> = [
      ["contract_authoring", 3, "define_project_contract"],
      ["project_execution", 25, "execute_bash"],
      ["project_review", 6, "get_project_review_case"],
      ["repair_review", 5, "check_workers"],
      ["input_resume", 6, "get_project_review_case"],
      ["operator_turn", 25, "operator_surface"],
    ];
    for (const [kind, rounds, firstTool] of cases) {
      const policy = policyMod.intentPolicyFor(kind);
      expect(policy.maxPromptRounds).toBe(rounds);
      if (firstTool === "operator_surface") {
        expect(policy.allowedTools).toBe("operator_surface");
      } else {
        expect(policy.allowedTools).toContain(firstTool);
      }
    }
  });

  it("authoring is actionable only before a contract; execution only after one", () => {
    const authoring = policyMod.intentPolicyFor("contract_authoring");
    expect(authoring.isActionable({ ...emptySnapshot(), supervisionState: "awaiting_contract", contractExists: false })).toBe(true);
    expect(authoring.isActionable({ ...emptySnapshot(), supervisionState: "executing", contractExists: true })).toBe(false);
    const execution = policyMod.intentPolicyFor("project_execution");
    expect(execution.isActionable({ ...emptySnapshot(), supervisionState: "executing", contractExists: true })).toBe(true);
    expect(execution.isActionable({ ...emptySnapshot(), supervisionState: "awaiting_contract", contractExists: false })).toBe(false);
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

  it("completion postconditions re-read durable state", () => {
    const authoring = policyMod.intentPolicyFor("contract_authoring");
    expect(authoring.completion({ ...emptySnapshot(), contractExists: true, supervisionState: "executing" }).satisfied).toBe(true);
    expect(authoring.completion(emptySnapshot()).satisfied).toBe(false);
    const execution = policyMod.intentPolicyFor("project_execution");
    expect(execution.completion({ ...emptySnapshot(), workerOwnedChild: true }).satisfied).toBe(true);
    expect(execution.completion({ ...emptySnapshot(), projectTerminal: true }).satisfied).toBe(true);
    expect(execution.completion(emptySnapshot()).satisfied).toBe(false);
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
    acceptedTerminalChildrenReady: false,
  };
}

describe("#1728 review dispatch escalation", () => {
  it("escalates project_review across dispatch ordinals: 6, 8, 10, then caps at 10", () => {
    expect(policyMod.effectiveMaxPromptRounds("project_review", 1)).toBe(6);
    expect(policyMod.effectiveMaxPromptRounds("project_review", 2)).toBe(8);
    expect(policyMod.effectiveMaxPromptRounds("project_review", 3)).toBe(10);
    expect(policyMod.effectiveMaxPromptRounds("project_review", 4)).toBe(10);
    expect(policyMod.effectiveMaxPromptRounds("project_review", 5)).toBe(10);
    expect(policyMod.effectiveMaxPromptRounds("project_review", 99)).toBe(10);
  });

  it("fails closed to the base bound on invalid ordinals and keeps every other intent fixed", () => {
    expect(policyMod.effectiveMaxPromptRounds("project_review")).toBe(6);
    expect(policyMod.effectiveMaxPromptRounds("project_review", 0)).toBe(6);
    expect(policyMod.effectiveMaxPromptRounds("project_review", -3)).toBe(6);
    expect(policyMod.effectiveMaxPromptRounds("project_review", 2.5)).toBe(6);
    expect(policyMod.effectiveMaxPromptRounds("project_review", Number.NaN)).toBe(6);
    expect(policyMod.effectiveMaxPromptRounds("contract_authoring", 9)).toBe(3);
    expect(policyMod.effectiveMaxPromptRounds("project_execution", 9)).toBe(25);
    expect(policyMod.effectiveMaxPromptRounds("repair_review", 4)).toBe(5);
    expect(policyMod.effectiveMaxPromptRounds("input_resume", 7)).toBe(6);
    expect(policyMod.effectiveMaxPromptRounds("operator_turn", 3)).toBe(25);
  });
});

describe("#1680 tool authorization matrix (schema + execution boundaries)", () => {
  const MATRIX: Array<[import("./orc-project-contracts.js").OrcIntentKind, string, boolean]> = [
    // authoring sees only the contract-definition capability
    ["contract_authoring", "define_project_contract", true],
    ["contract_authoring", "execute_bash", false],
    ["contract_authoring", "spawn_worker", false],
    ["contract_authoring", "review_project", false],
    ["contract_authoring", "memory_recall", false],
    // project execution cannot author or review
    ["project_execution", "execute_bash", true],
    ["project_execution", "spawn_worker", true],
    ["project_execution", "define_project_contract", false],
    ["project_execution", "review_project", false],
    ["project_execution", "peer_ask_help", true],
    // #1728: the durable-handoff yield is execution-only
    ["contract_authoring", "yield_turn", false],
    ["project_execution", "yield_turn", true],
    ["project_review", "yield_turn", false],
    ["repair_review", "yield_turn", false],
    ["input_resume", "yield_turn", false],
    // review intents cannot execute or author
    ["project_review", "get_project_review_case", true],
    ["project_review", "review_project", true],
    ["project_review", "execute_bash", false],
    ["project_review", "define_project_contract", false],
    ["repair_review", "check_workers", true],
    ["repair_review", "execute_bash", false],
    ["input_resume", "review_project", true],
    ["input_resume", "spawn_worker", false],
    // operator turns retain the full surface
    ["operator_turn", "execute_bash", true],
    ["operator_turn", "define_project_contract", true],
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
