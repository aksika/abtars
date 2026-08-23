/**
 * sha-log-anomaly.test.ts — #1708 Tasks 5-6: durable anomaly admission through
 * the REAL coordinator, incident store, policy view, and Kanban provisioning
 * boundary, exactly as the #1709 detector will consume them.
 *
 * Ownership split proved here:
 *  - #1709 owns detection, its main-agent warning (mode-independent), and any
 *    live off-mode heartbeat approval — modeled as an external producer step;
 *  - #1708 owns validation, identity, policy/mode gates, atomic provisioning,
 *    and the durable anomaly cooldown.
 * Detector sampling, log scanning, retention, and heartbeat registration are
 * deliberately absent — they are #1709 evidence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShaIncidentCoordinator } from "./sha-incident-coordinator.js";
import { ShaIncidentStore } from "./sha-incident-store.js";
import { shaAdmissionNotice } from "./sha-admission-notice.js";
import type { LogAnomalyEvent } from "./sha-types.js";
import { nerve } from "../nerve.js";
import { requireTaskDatabase } from "../tasks/kanban-board.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

let TEST_HOME: string;
let db: TaskDatabase;
const savedHome = process.env["ABTARS_HOME"];

async function setup(): Promise<void> {
  TEST_HOME = join(tmpdir(), `sha-anomaly-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env["ABTARS_HOME"] = TEST_HOME;
  mkdirSync(join(TEST_HOME, "config"), { recursive: true });
  mkdirSync(join(TEST_HOME, "kanban"), { recursive: true });
  db = requireTaskDatabase();
}

beforeEach(async () => {
  await setup();
  // Ensure the sha_* schema exists before any zero-write assertions.
  new ShaIncidentStore(db);
  for (const table of [
    "sha_incident_transitions", "sha_incident_events", "sha_incidents", "sha_fault_state",
    "worker_attempts", "worker_contracts", "project_contracts", "project_supervision",
    "kanban_card_transitions", "kanban_board",
  ]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table absent on fresh DB */ }
  }
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["ABTARS_HOME"];
  else process.env["ABTARS_HOME"] = savedHome;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const LOG_PATH = "/home/u/.abtars/logs/abtars.log";

function anomalyEvent(overrides: Partial<LogAnomalyEvent> = {}): LogAnomalyEvent {
  const t0 = 1_700_000_000_000;
  return {
    source: "logAnomaly",
    schemaVersion: 1,
    anomalyKind: "growth_rate",
    logPath: LOG_PATH,
    inode: 42,
    episodeStartedAt: t0,
    windowStartedAt: t0 + 60_000,
    windowEndedAt: t0 + 120_000,
    sampleCount: 30,
    baselineBytesPerMinute: 500,
    observedBytesPerMinute: 25_000,
    ratio: 50,
    evidence: "active log growing 50x baseline",
    ...overrides,
  };
}

interface FixturePolicy {
  shaAllowed: boolean;
  minimumMode: "investigation" | "full";
  cooldownMinutes: number;
  notifyMain: boolean;
}

function makeCoordinator(overrides: {
  mode?: "off" | "investigation" | "full";
  policy?: Partial<FixturePolicy>;
} = {}): ShaIncidentCoordinator {
  const policy: FixturePolicy = {
    shaAllowed: true,
    minimumMode: "investigation",
    cooldownMinutes: 60,
    notifyMain: true,
    ...overrides.policy,
  };
  return new ShaIncidentCoordinator({
    db,
    modeProvider: () => overrides.mode ?? "investigation",
    // Deterministic effective-policy view resolved exactly like the real
    // default view would resolve from sha-policy.json guardrails.
    policyView: () => ({
      fixes: [],
      logAdmissionAllowed: true,
      logAnomaly: {
        shaAllowed: policy.shaAllowed,
        minimumMode: policy.minimumMode,
        cooldownMinutes: policy.cooldownMinutes,
      },
    }),
    aliasAvailability: () => null,
  });
}

/** Producer-side pre-admission warning (#1709 responsibility), modeled. */
function producerWarning(policy: FixturePolicy): string | null {
  return policy.notifyMain ? "[warn] active log growth detected on abtars.log" : null;
}

function shaRowCounts(): { incidents: number; events: number; roots: number } {
  const incidents = Number(db.prepare("SELECT COUNT(*) AS n FROM sha_incidents").get()?.["n"] ?? 0);
  const events = Number(db.prepare("SELECT COUNT(*) AS n FROM sha_incident_events").get()?.["n"] ?? 0);
  const roots = Number(db.prepare("SELECT COUNT(*) AS n FROM kanban_board WHERE source = 'sha'").get()?.["n"] ?? 0);
  return { incidents, events, roots };
}

describe("#1708 anomaly admission through the real coordinator", () => {
  it("off mode: producer warning still fires, coordinator performs zero SHA writes", () => {
    const before = shaRowCounts();
    const coordinator = makeCoordinator({ mode: "off" });
    const event = anomalyEvent();

    // Producer-side warning (notifyMain independent of SELFHEAL_MODE): the
    // #1709 detector emits its own notice BEFORE asking the coordinator.
    expect(producerWarning({
      shaAllowed: true, minimumMode: "investigation", cooldownMinutes: 60, notifyMain: true,
    })).toContain("[warn]");

    const outcome = coordinator.admit(event);
    expect(outcome).toMatchObject({ kind: "ignored", reason: "off" });
    expect(shaRowCounts()).toEqual(before);
    expect(shaAdmissionNotice(event, outcome)).toBe("SHA: off — no self-healing action.");
  });

  it("policy denial suppresses without touching any store or Kanban row", () => {
    const before = shaRowCounts();
    const coordinator = makeCoordinator({ mode: "full", policy: { shaAllowed: false } });
    const outcome = coordinator.admit(anomalyEvent());
    expect(outcome).toMatchObject({ kind: "ignored", reason: "suppressed" });
    expect(shaRowCounts()).toEqual(before);
  });

  it("below-minimum mode suppresses: investigation never satisfies a full-only gate", () => {
    const coordinator = makeCoordinator({ mode: "investigation", policy: { minimumMode: "full" } });
    expect(coordinator.admit(anomalyEvent())).toMatchObject({ kind: "ignored", reason: "suppressed" });
  });

  it("an invalid producer payload is rejected before classification or persistence", async () => {
    const before = shaRowCounts();
    const coordinator = makeCoordinator();
    const nerveFire = vi.spyOn(nerve, "fire");
    const outcome = coordinator.admit({ ...anomalyEvent(), ratio: 3 } as LogAnomalyEvent);
    expect(outcome).toMatchObject({ kind: "ignored", reason: "ambiguous" });
    expect(shaRowCounts()).toEqual(before);
    expect(nerveFire).not.toHaveBeenCalled();
    nerveFire.mockRestore();
  });

  it("investigation admits one RCA/design project — never a solution stage", () => {
    const coordinator = makeCoordinator({ mode: "investigation" });
    const outcome = coordinator.admit(anomalyEvent());
    expect(outcome.kind).toBe("project_created");
    if (outcome.kind !== "project_created") return;
    expect(outcome.mode).toBe("investigation");

    const cards = db.prepare("SELECT title FROM kanban_board ORDER BY id").all() as Array<{ title: string }>;
    expect(cards).toHaveLength(3);
    expect(cards.some((c) => /solution/i.test(c.title))).toBe(false);

    // Durable identity: source='log', scope is the full path hash — no new enum.
    const incident = db.prepare(
      "SELECT source, source_scope, mode, state FROM sha_incidents WHERE id = ?",
    ).get(outcome.incidentId) as Record<string, unknown>;
    expect(incident["source"]).toBe("log");
    expect(String(incident["source_scope"])).toMatch(/^log-anomaly:[0-9a-f]{64}$/);
    expect(incident["mode"]).toBe("investigation");
    expect(incident["state"]).toBe("rca");

    // occurred_at derives from windowEndedAt.
    const eventRow = db.prepare(
      "SELECT occurred_at FROM sha_incident_events WHERE incident_id = ?",
    ).get(outcome.incidentId) as Record<string, unknown>;
    expect(new Date(String(eventRow["occurred_at"])).getTime()).toBe(1_700_000_120_000);
  });

  it("full mode may provision the isolated solution placeholder", () => {
    const coordinator = makeCoordinator({ mode: "full" });
    const outcome = coordinator.admit(anomalyEvent());
    expect(outcome.kind).toBe("project_created");
    const cards = db.prepare("SELECT title FROM kanban_board ORDER BY id").all() as Array<{ title: string }>;
    expect(cards).toHaveLength(4);
    expect(cards.some((c) => /SHA solution/.test(c.title))).toBe(true);
  });

  it("repeated samples in one episode reuse the event key — duplicates, not new admissions", () => {
    const coordinator = makeCoordinator({ mode: "investigation" });
    const first = coordinator.admit(anomalyEvent());
    expect(first.kind).toBe("project_created");
    const replay = coordinator.admit(anomalyEvent());
    expect(replay.kind).toBe("duplicate_event");
    // Re-sample with fresh rates but identical episode identity: still duplicate.
    const resample = coordinator.admit(anomalyEvent({ observedBytesPerMinute: 90_000, ratio: 180 }));
    expect(resample.kind).toBe("duplicate_event");
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM kanban_board WHERE source = 'sha'").get()?.["n"])).toBe(3); // root + rca + design
  });

  it("inode rotation cannot fork a second logical fault nor bypass cooldown", () => {
    const coordinator = makeCoordinator({ mode: "investigation" });
    const first = coordinator.admit(anomalyEvent());
    expect(first.kind).toBe("project_created");
    if (first.kind !== "project_created") return;

    // Rotation mid-episode: same path, new inode, later window — attaches to
    // the SAME active logical fault (fingerprint excludes inode/rates/time).
    const rotated = coordinator.admit(anomalyEvent({
      inode: 777,
      windowStartedAt: 1_700_000_180_000,
      windowEndedAt: 1_700_000_240_000,
      observedBytesPerMinute: 40_000,
      ratio: 80,
    }));
    expect(rotated.kind).toBe("attached");
    if (rotated.kind !== "attached") return;
    expect(rotated.incidentId).toBe(first.incidentId);

    // Terminalize the episode; a NEW episode within the effective cooldown is
    // refused with a silent ignore — no second root card.
    const moved = db.prepare(
      "UPDATE sha_incidents SET state = 'blocked', terminal_at = ?, version = version + 1 WHERE id = ?",
    ).run(new Date().toISOString(), first.incidentId);
    expect(moved.changes).toBe(1);

    const nextEpisode = coordinator.admit(anomalyEvent({
      inode: 999,
      episodeStartedAt: 1_700_000_300_000,
      windowStartedAt: 1_700_000_360_000,
      windowEndedAt: 1_700_000_420_000,
    }));
    expect(nextEpisode).toMatchObject({ kind: "ignored", reason: "cooldown" });
    // Cooldown outcome produces NO operator message.
    expect(shaAdmissionNotice(anomalyEvent(), nextEpisode)).toBeNull();
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM kanban_board WHERE source = 'sha' AND type = 'O'").get()?.["n"])).toBe(1);
  });

  it("concurrent callbacks for one logical fault provision exactly one root", () => {
    const coordinator = makeCoordinator({ mode: "full" });
    const outcomes = [
      coordinator.admit(anomalyEvent()),
      coordinator.admit(anomalyEvent({ inode: 555 })),
    ];
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["attached", "project_created"].sort());
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM kanban_board WHERE source = 'sha' AND type = 'O'").get()?.["n"])).toBe(1);
  });

  it("different logs are distinct faults with separate scopes", () => {
    const coordinator = makeCoordinator({ mode: "investigation" });
    const a = coordinator.admit(anomalyEvent());
    const b = coordinator.admit(anomalyEvent({ logPath: "/home/u/.abtars/logs/error.log" }));
    expect(a.kind).toBe("project_created");
    expect(b.kind).toBe("project_created");
    const scopes = db.prepare("SELECT DISTINCT source_scope FROM sha_incidents").all() as Array<{ source_scope: string }>;
    expect(scopes).toHaveLength(2);
  });

  it("coordinator re-redacts producer evidence and stores valid bounded diagnostic JSON", () => {
    const coordinator = makeCoordinator({ mode: "investigation" });
    const outcome = coordinator.admit(anomalyEvent({
      evidence: "growth spike API_KEY=supersecretvalue123 persisted",
    }));
    expect(outcome.kind).toBe("project_created");
    const row = db.prepare(
      "SELECT diagnostic_json FROM sha_incident_events LIMIT 1",
    ).get() as Record<string, unknown>;
    const json = String(row["diagnostic_json"]);
    // Valid JSON, UTF-8-bounded, secret-free, no raw-log dump.
    expect(() => JSON.parse(json)).not.toThrow();
    expect(Buffer.byteLength(json, "utf-8")).toBeLessThanOrEqual(8192);
    expect(json).not.toContain("supersecretvalue123");
    expect(json).toContain("growth spike");
  });
});
