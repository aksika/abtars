/**
 * reconcile.test.ts — runtime tree reconciliation, incl. canonical sleep-cycle
 * task seeding for existing tasks.json files (#1321).
 */
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

describe("#1321 reconcile canonical sleep-cycle task", () => {
  beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); mkdirSync(HOME, { recursive: true }); });
  afterEach(() => rmSync(HOME, { recursive: true, force: true }));

  it("appends sleep-cycle to an existing tasks.json when the id is absent", () => {
    mkdirSync(join(HOME, "tasks"), { recursive: true });
    writeFileSync(tasksPath(), JSON.stringify([
      { id: "morning-greeting", type: "task", executor: "agent", schedule: "0 9 * * *", message: "hi", chatId: 1, fired: false, createdAt: 0 },
    ]), "utf-8");

    // templatesSrc may not exist in this synthetic test — reconcile() logs + skips,
    // but seedCanonicalSystemTasks runs regardless. Pass a missing templates path.
    reconcile(join(HOME, "no-such-templates"), HOME);

    const entries = readTasks();
    const ids = entries.map(e => (e as { id: string }).id);
    expect(ids).toContain("sleep-cycle");
    expect(ids).toContain("hardware-sleep");
    // Existing entry preserved untouched.
    expect(ids).toContain("morning-greeting");
    const seeded = entries.find(e => (e as { id: string }).id === "sleep-cycle") as Record<string, unknown>;
    expect(seeded["executor"]).toBe("system");
    expect(seeded["action"]).toBe("sleep-cycle");
  });

  it("never overwrites an existing sleep-cycle entry's schedule or pause state", () => {
    mkdirSync(join(HOME, "tasks"), { recursive: true });
    writeFileSync(tasksPath(), JSON.stringify([
      { id: "sleep-cycle", executor: "system", action: "sleep-cycle", schedule: "0 3 * * *", paused: true, type: "task", fired: false, createdAt: 0 },
      // hardware-sleep must also be present: both are in CANONICAL_SYSTEM_TASKS
      { id: "hardware-sleep", executor: "system", action: "hardware-sleep", schedule: "30 3 * * *", paused: true, type: "task", fired: false, createdAt: 0 },
    ]), "utf-8");

    reconcile(join(HOME, "no-such-templates"), HOME);

    const entries = readTasks();
    expect(entries.length).toBe(2); // sleep-cycle + hardware-sleep
    const entry = entries.find(e => (e as { id: string }).id === "sleep-cycle") as Record<string, unknown>;
    expect(entry["schedule"]).toBe("0 3 * * *"); // user edit preserved
    expect(entry["paused"]).toBe(true);          // pause state preserved
  });

  it("creates tasks.json with the canonical entry when none exists", () => {
    reconcile(join(HOME, "no-such-templates"), HOME);
    const ids = readTasks().map(e => (e as { id: string }).id);
    expect(ids).toContain("sleep-cycle");
    expect(ids).toContain("hardware-sleep");
  });
});
