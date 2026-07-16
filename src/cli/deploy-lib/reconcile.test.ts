import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcile } from "./reconcile.js";

const HOME = join(tmpdir(), `ab-reconcile-test-${process.pid}`);

function tasksPath(): string { return join(HOME, "tasks", "tasks.json"); }

function readTasks(): unknown[] {
  if (!existsSync(tasksPath())) return [];
  const raw = JSON.parse(readFileSync(tasksPath(), "utf-8"));
  return Array.isArray(raw) ? raw : [];
}

/** Create a minimal templates/tasks/tasks.json with sleep-cycle entry. */
function seedTemplate(): void {
  const dir = join(HOME, "templates", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.json"), JSON.stringify([
    { id: "morning-greeting", type: "task", executor: "agent", schedule: "0 9 * * *", message: "hi" },
    { id: "sleep-cycle", type: "task", executor: "system", action: "sleep-cycle", schedule: "0 2 * * *", catchUp: 6, maxRunsPerDay: 1, deliveryMode: "silent", paused: false },
    { id: "hardware-sleep", type: "task", executor: "system", action: "hardware-sleep", schedule: "30 3 * * *", idleMinutes: 20, paused: true },
  ], null, 2), "utf-8");
}

describe("#1321 reconcile sleep-cycle from template", () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(join(HOME, "templates", "config"), { recursive: true });
  });
  afterEach(() => rmSync(HOME, { recursive: true, force: true }));

  const CANONICAL_PI_EXECUTOR = JSON.stringify({
    enabled: false,
    command: "pi",
    fixedArgs: [],
    allowedEnv: [],
    maxConcurrent: 1,
    maxWallClockMs: 1800000,
    abortGraceMs: 10000,
    projectTrust: "never",
    workspaceAliases: {},
    sessionStorageRoot: "",
    abmindPlugin: "",
  }, null, 2) + "\n";

  /** Create templates/config/pi-executor.json in the test HOME. */
  function seedPiExecutorTemplate(): void {
    const dir = join(HOME, "templates", "config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pi-executor.json"), CANONICAL_PI_EXECUTOR, "utf-8");
  }

  it("seeds pi-executor.json when absent (#1440)", () => {
    seedPiExecutorTemplate();
    reconcile(join(HOME, "templates"), HOME);
    const seeded = readFileSync(join(HOME, "config", "pi-executor.json"), "utf-8");
    expect(seeded).toBe(CANONICAL_PI_EXECUTOR);
  });

  it("preserves existing pi-executor.json (#1440)", () => {
    seedPiExecutorTemplate();
    mkdirSync(join(HOME, "config"), { recursive: true });
    const modified = JSON.stringify({ enabled: true, command: "/custom/pi", workspaceAliases: { work: { path: "/home/me/work" } } });
    writeFileSync(join(HOME, "config", "pi-executor.json"), modified, "utf-8");
    reconcile(join(HOME, "templates"), HOME);
    const result = readFileSync(join(HOME, "config", "pi-executor.json"), "utf-8");
    expect(result).toBe(modified);
  });

  it("appends sleep-cycle when absent, does not seed hardware-sleep", () => {
    seedTemplate();
    mkdirSync(join(HOME, "tasks"), { recursive: true });
    writeFileSync(tasksPath(), JSON.stringify([
      { id: "morning-greeting", type: "task", executor: "agent", schedule: "0 9 * * *", message: "hi", chatId: 1, fired: false, createdAt: 0 },
    ]), "utf-8");

    reconcile(join(HOME, "templates"), HOME);

    const entries = readTasks();
    const ids = entries.map(e => (e as { id: string }).id);
    expect(ids).toContain("sleep-cycle");
    expect(ids).not.toContain("hardware-sleep");
    expect(ids).toContain("morning-greeting");
    const seeded = entries.find(e => (e as { id: string }).id === "sleep-cycle") as Record<string, unknown>;
    expect(seeded["executor"]).toBe("system");
    expect(seeded["action"]).toBe("sleep-cycle");
  });

  it("never overwrites an existing sleep-cycle entry's schedule or pause state", () => {
    seedTemplate();
    mkdirSync(join(HOME, "tasks"), { recursive: true });
    writeFileSync(tasksPath(), JSON.stringify([
      { id: "sleep-cycle", executor: "system", action: "sleep-cycle", schedule: "0 3 * * *", paused: true, type: "task", fired: false, createdAt: 0 },
    ]), "utf-8");

    reconcile(join(HOME, "templates"), HOME);

    const entries = readTasks();
    expect(entries).toHaveLength(1);
    const entry = entries.find(e => (e as { id: string }).id === "sleep-cycle") as Record<string, unknown>;
    expect(entry["schedule"]).toBe("0 3 * * *");
    expect(entry["paused"]).toBe(true);
  });

  it("creates tasks.json with sleep-cycle when none exists", () => {
    seedTemplate();
    reconcile(join(HOME, "templates"), HOME);
    const ids = readTasks().map(e => (e as { id: string }).id);
    expect(ids).toContain("sleep-cycle");
    // full template copied since no file existed — hardware-sleep comes from seed, not reconcile
  });

  it("does nothing when no template exists", () => {
    reconcile(join(HOME, "templates"), HOME);
    expect(readTasks()).toEqual([]);
  });
});
