import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTaskFile } from "./task-validator.js";

const origHome = process.env.HOME;
const origAbtarsHome = process.env.ABTARS_HOME;

describe("validateTaskFile", () => {
  let home: string;
  let abtarsHome: string;
  let taskRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "task-valid-"));
    abtarsHome = join(home, ".abtars");
    taskRoot = join(abtarsHome, "tasks");
    process.env.HOME = home;
    process.env.ABTARS_HOME = abtarsHome;
    mkdirSync(taskRoot, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origAbtarsHome === undefined) delete process.env.ABTARS_HOME;
    else process.env.ABTARS_HOME = origAbtarsHome;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  });

  function writeTasks(entries: unknown[]): string {
    const p = join(taskRoot, "tasks.json");
    writeFileSync(p, JSON.stringify(entries, null, 2), "utf-8");
    return p;
  }

  function validAgent(id: string, extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      id,
      kind: "agent",
      agent: "task",
      delivery: "announce",
      schedule: "0 9 * * *",
      prompt: `prompt ${id}`,
      interaction: { mode: "oneshot" },
      orchestration: { maxAgents: 1 },
      enabled: true,
      priority: "medium",
      ...(extra ?? {}),
    };
  }

  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) out[p] = readFileSync(p, "utf-8");
      }
    };
    if (existsSync(dir)) walk(dir);
    return out;
  }

  it("returns ok with zero findings for a valid file and matching package tree", () => {
    mkdirSync(join(taskRoot, "valid-one"), { recursive: true });
    writeFileSync(join(taskRoot, "valid-one", "TASK.md"), "# TASK\nDo the thing.\n");
    const p = writeTasks([validAgent("valid-one", { taskFile: join(taskRoot, "valid-one", "TASK.md") })]);

    const result = validateTaskFile(p);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.path).toBe(p);
    expect(result.summary).toEqual({ entryCount: 1, validEntryCount: 1, findingCount: 0 });
  });

  it("accumulates all findings in deterministic order across one document", () => {
    mkdirSync(join(taskRoot, "valid-one"), { recursive: true });
    writeFileSync(join(taskRoot, "valid-one", "TASK.md"), "# TASK");
    mkdirSync(join(taskRoot, "orphan-a"), { recursive: true });
    mkdirSync(join(taskRoot, "orphan-b"), { recursive: true });
    mkdirSync(join(abtarsHome, "workspace", "report-one"), { recursive: true });
    writeFileSync(join(abtarsHome, "workspace", "report-one", "feed.csv"), "feed");
    const feedMissing = join(abtarsHome, "workspace", "report-one", "feed-missing.csv");

    const entries: unknown[] = [
      validAgent("valid-one", { taskFile: join(taskRoot, "valid-one", "TASK.md") }),
      { id: "bad-entry", kind: "agent", agent: "task", delivery: "announce", prompt: "x", interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 } },
      validAgent("report-one", {
        delivery: "report",
        report: {
          artifact: "~/workspace/report-one/output.md",
          requiredSections: ["# Report"],
          minBytes: 100,
          requires: {
            files: [join(abtarsHome, "workspace", "report-one", "feed.csv"), feedMissing],
            executables: [],
            tools: [],
          },
        },
      }),
      validAgent("valid-one"),
      validAgent("missing-file", { taskFile: "~/.abtars/tasks/missing-file/TASK.md" }),
    ];
    const p = writeTasks(entries);

    const result = validateTaskFile(p);
    expect(result.ok).toBe(false);
    expect(result.summary).toEqual({ entryCount: 5, validEntryCount: 4, findingCount: 6 });
    expect(result.findings.map(f => f.code)).toEqual([
      "entry_invalid",
      "duplicate_id",
      "required_file_missing",
      "task_file_missing",
      "orphan_task_package",
      "orphan_task_package",
    ]);
    expect(result.findings[0]).toMatchObject({ entryIndex: 1, entryId: "bad-entry" });
    expect(result.findings[1]).toMatchObject({ entryIndex: 3, entryId: "valid-one" });
    expect(result.findings[2]).toMatchObject({
      entryIndex: 2,
      entryId: "report-one",
      configuredPath: feedMissing,
      path: feedMissing,
    });
    expect(result.findings[3]).toMatchObject({
      entryIndex: 4,
      entryId: "missing-file",
      configuredPath: "~/.abtars/tasks/missing-file/TASK.md",
      path: join(taskRoot, "missing-file", "TASK.md"),
    });
    expect(result.findings[4]).toMatchObject({ path: join(taskRoot, "orphan-a") });
    expect(result.findings[5]).toMatchObject({ path: join(taskRoot, "orphan-b") });
  });

  it("reports the default live path when no path is given", () => {
    const p = join(taskRoot, "tasks.json");
    writeFileSync(p, "[]", "utf-8");
    const result = validateTaskFile();
    expect(result.path).toBe(p);
    expect(result.ok).toBe(true);
  });

  it("reports file_missing for a missing document without orphan findings", () => {
    const result = validateTaskFile();
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { code: "file_missing", message: `task file not found: ${join(taskRoot, "tasks.json")}`, path: join(taskRoot, "tasks.json") },
    ]);
    expect(result.summary.entryCount).toBe(0);
  });

  it("reports json_invalid for malformed JSON", () => {
    const p = join(taskRoot, "tasks.json");
    writeFileSync(p, "not json {", "utf-8");
    const result = validateTaskFile(p);
    expect(result.ok).toBe(false);
    expect(result.findings.map(f => f.code)).toEqual(["json_invalid"]);
    expect(result.summary.entryCount).toBe(0);
  });

  it("reports root_not_array for a non-array root", () => {
    const p = join(taskRoot, "tasks.json");
    writeFileSync(p, "{ \"id\": \"x\" }", "utf-8");
    const result = validateTaskFile(p);
    expect(result.ok).toBe(false);
    expect(result.findings.map(f => f.code)).toEqual(["root_not_array"]);
    expect(result.summary.entryCount).toBe(0);
  });

  it("reports required_file_unreadable for a symlinked required file", () => {
    mkdirSync(join(abtarsHome, "workspace", "sym-report"), { recursive: true });
    writeFileSync(join(abtarsHome, "workspace", "sym-report", "real.txt"), "data");
    const link = join(abtarsHome, "workspace", "sym-report", "linked.txt");
    try {
      symlinkSync(join(abtarsHome, "workspace", "sym-report", "real.txt"), link);
    } catch {
      return;
    }
    const p = writeTasks([
      validAgent("sym-report", {
        delivery: "report",
        report: {
          artifact: "~/workspace/sym-report/output.md",
          requiredSections: ["# Report"],
          minBytes: 100,
          requires: { files: [link], executables: [], tools: [] },
        },
      }),
    ]);
    const result = validateTaskFile(p);
    expect(result.findings.map(f => f.code)).toEqual(["required_file_unreadable"]);
    expect(result.findings[0]).toMatchObject({ entryId: "sym-report", configuredPath: link, path: link });
  });

  it("reports task_packages_unreadable when the package root cannot be read (non-root only)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    // The JSON lives outside the unreadable root so only the orphan scan fails.
    const p = join(home, "elsewhere.json");
    writeFileSync(p, JSON.stringify([validAgent("pkg-one")], null, 2), "utf-8");
    try { chmodSync(taskRoot, 0o000); } catch { return; }
    try {
      const result = validateTaskFile(p);
      expect(result.findings.map(f => f.code)).toEqual(["task_packages_unreadable"]);
      expect(result.findings[0]).toMatchObject({ path: taskRoot });
    } finally {
      chmodSync(taskRoot, 0o700);
    }
  });

  it("is a pure dry run — creates and changes no files or directories", () => {
    mkdirSync(join(taskRoot, "valid-one"), { recursive: true });
    writeFileSync(join(taskRoot, "valid-one", "TASK.md"), "# TASK");
    mkdirSync(join(taskRoot, "orphan-a"), { recursive: true });
    const entries: unknown[] = [
      validAgent("valid-one", { taskFile: join(taskRoot, "valid-one", "TASK.md") }),
      { id: "bad-entry", kind: "agent", agent: "task", delivery: "announce", prompt: "x", interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 } },
    ];
    const p = writeTasks(entries);

    const before = snapshot(abtarsHome);
    const result = validateTaskFile(p);
    const after = snapshot(abtarsHome);

    expect(result.ok).toBe(false);
    expect(after).toEqual(before);
    expect(existsSync(join(abtarsHome, "workspace"))).toBe(false);
    expect(existsSync(join(abtarsHome, "task-state.json"))).toBe(false);
  });
});
