import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORPHAN_GRACE_MS,
  ORPHAN_MARKER_FILENAME,
  reclaimOrphanedProjectWorkspaces,
  type ReclaimDatabase,
} from "./project-workspace-reclaim.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function makeDb(cards: number[], opts?: { missingTable?: boolean; throwing?: boolean; total?: number }): ReclaimDatabase {
  const set = new Set(cards);
  // Board total is independent of the queried card set: a real board holds
  // other cards while the orphan candidate is absent.
  const total = opts?.total ?? Math.max(cards.length, 1);
  return {
    prepare(sql: string) {
      return {
        get(...params: unknown[]): Record<string, unknown> | undefined {
          if (opts?.throwing === true) throw new Error("db is on fire");
          if (sql.includes("sqlite_master")) {
            return opts?.missingTable === true ? undefined : { name: "kanban_board" };
          }
          if (sql.includes("COUNT(*)")) return { n: total };
          const id = params[0];
          return typeof id === "number" && set.has(id) ? { one: 1 } : undefined;
        },
      };
    },
  };
}

describe("reclaimOrphanedProjectWorkspaces", () => {
  let tmp: string;
  let projects: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reclaim-"));
    projects = join(tmp, "projects");
    mkdirSync(projects, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function cardDir(id: number): string {
    const dir = join(projects, String(id));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function run(cards: number[], opts?: { missingTable?: boolean; throwing?: boolean; total?: number; dbNull?: boolean; now?: number }) {
    return reclaimOrphanedProjectWorkspaces(
      opts?.dbNull === true ? null : makeDb(cards, opts),
      projects,
      () => opts?.now ?? NOW,
    );
  }

  it("removes a directory whose marker aged past the grace", () => {
    const dir = cardDir(7);
    writeFileSync(join(dir, ORPHAN_MARKER_FILENAME), `${NOW - ORPHAN_GRACE_MS - DAY_MS}\n`, "utf-8");
    const summary = run([]);
    expect(summary.removed).toEqual([7]);
    expect(existsSync(dir)).toBe(false);
  });

  it("arms the grace on first observation and removes nothing", () => {
    const dir = cardDir(7);
    // mtime-old tree: mtime must not satisfy the grace (observation-anchored, not mtime).
    const ancient = new Date(NOW - 30 * DAY_MS);
    utimesSync(dir, ancient, ancient);
    const summary = run([]);
    expect(summary.removed).toEqual([]);
    expect(summary.marked).toEqual([7]);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, ORPHAN_MARKER_FILENAME), "utf-8").trim()).toBe(String(NOW));
  });

  it("keeps a directory inside the grace and removes it once the marker ages", () => {
    const dir = cardDir(7);
    run([]);
    expect(existsSync(dir)).toBe(true);
    const later = run([], { now: NOW + ORPHAN_GRACE_MS + 1 });
    expect(later.removed).toEqual([7]);
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves present cards alone and clears a stale marker on reappearance", () => {
    const live = cardDir(3);
    const stale = cardDir(4);
    writeFileSync(join(stale, ORPHAN_MARKER_FILENAME), `${NOW - 10 * DAY_MS}\n`, "utf-8");
    const summary = run([3, 4]);
    expect(summary.removed).toEqual([]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(join(live, ORPHAN_MARKER_FILENAME))).toBe(false);
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(join(stale, ORPHAN_MARKER_FILENAME))).toBe(false);
  });

  it("deletes nothing when the database is broken, missing, or empty", () => {
    const cases = [{ throwing: true }, { missingTable: true }, { total: 0 }] as const;
    for (const opts of cases) {
      const dir = cardDir(9);
      const summary = run([], opts);
      expect(summary.removed).toEqual([]);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, ORPHAN_MARKER_FILENAME))).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }
    const nullSummary = run([], { dbNull: true });
    expect(nullSummary).toEqual({ scanned: 0, removed: [], marked: [] });
  });

  it("ignores non-numeric names, non-directories, and non-canonical numerals", () => {
    mkdirSync(join(projects, "abc"));
    mkdirSync(join(projects, "12x"));
    writeFileSync(join(projects, "99"), "stray file", "utf-8");
    mkdirSync(join(projects, "007"));
    const summary = run([]);
    expect(summary).toEqual({ scanned: 0, removed: [], marked: [] });
    expect(existsSync(join(projects, "abc"))).toBe(true);
    expect(existsSync(join(projects, "99"))).toBe(true);
    expect(existsSync(join(projects, "007"))).toBe(true);
  });

  it("refuses a symlink escaping the projects root without writing through it", () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "live", "utf-8");
    symlinkSync(outside, join(projects, "11"));
    const summary = run([]);
    expect(summary).toEqual({ scanned: 0, removed: [], marked: [] });
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(join(outside, ORPHAN_MARKER_FILENAME))).toBe(false);
    expect(existsSync(join(projects, "11"))).toBe(true);
  });

  it("refuses a symlink pointed at the projects root itself", () => {
    symlinkSync(projects, join(projects, "12"));
    const summary = run([]);
    expect(summary).toEqual({ scanned: 0, removed: [], marked: [] });
    expect(existsSync(projects)).toBe(true);
  });

  it("refuses an in-root symlink without marking or deleting its target", () => {
    const target = join(projects, "target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "live", "utf-8");
    symlinkSync(target, join(projects, "14"));
    const summary = run([]);
    expect(summary).toEqual({ scanned: 0, removed: [], marked: [] });
    expect(existsSync(join(projects, "14"))).toBe(true);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
    expect(existsSync(join(target, ORPHAN_MARKER_FILENAME))).toBe(false);
  });

  it("removes every due directory in one pass and never looks outside the root", () => {
    const sibling = join(tmp, "sibling-task-workspace");
    mkdirSync(sibling, { recursive: true });
    const due: number[] = [];
    for (const id of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const dir = cardDir(id);
      writeFileSync(join(dir, ORPHAN_MARKER_FILENAME), `${NOW - ORPHAN_GRACE_MS - 1}\n`, "utf-8");
      due.push(id);
    }
    const summary = run([]);
    expect(summary.removed).toEqual(due);
    expect(existsSync(sibling)).toBe(true);
  });

  it("re-arms an unparseable marker instead of deleting", () => {
    const corrupt = ["not-a-time", "123abc", ""];
    for (const content of corrupt) {
      const dir = cardDir(31);
      writeFileSync(join(dir, ORPHAN_MARKER_FILENAME), content, "utf-8");
      // A stale mtime must not matter: only a valid integer can satisfy the grace.
      const ancient = new Date(NOW - 30 * DAY_MS);
      utimesSync(dir, ancient, ancient);
      const summary = run([]);
      expect(summary.removed).toEqual([]);
      expect(existsSync(dir)).toBe(true);
      expect(readFileSync(join(dir, ORPHAN_MARKER_FILENAME), "utf-8").trim()).toBe(String(NOW));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
