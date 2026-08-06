/**
 * kanban-transition-boundary.test.ts — #1590 source-boundary regression.
 *
 * kanbanTransition in kanban-board.ts is the ONLY code permitted to write
 * kanban_board.status. This test greps the src/ tree and fails if any
 * non-test file reintroduces a raw status write, and if kanbanUpdate's field
 * type still admits `status`. Without this, the eighth writer appears within
 * a month.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(__dirname, "..", "..", "..", "src");

/** UPDATE kanban_board SET ... where `status` is one of the assigned columns. */
const STATUS_WRITE_RE = /UPDATE\s+kanban_board\s+SET[\s\S]*?\bstatus\s*=\s*(['"`]|\?)/i;

function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

describe("#1590 source boundary", () => {
  it("no raw kanban_board status write exists outside kanban-board.ts", () => {
    const offenders: Array<{ file: string; line: number }> = [];
    for (const file of collectSourceFiles()) {
      // Test files and the e2e/integration trees legitimately seed status
      // directly — fixtures, not production writers.
      if (file.includes(".test.ts") || file.includes("src/tests/")) continue;
      const rel = relative(SRC_ROOT, file);
      if (rel === "components/tasks/kanban-board.ts") continue;
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (STATUS_WRITE_RE.test(lines[i]!)) {
          offenders.push({ file: rel, line: i + 1 });
        }
      }
    }
    expect(offenders, `raw status writes must go through kanbanTransition (see kanban-board.ts): ${offenders.map(o => `${o.file}:${o.line}`).join(", ")}`).toEqual([]);
  });

  it("kanbanUpdate's field type no longer admits status", () => {
    const board = readFileSync(join(SRC_ROOT, "components/tasks/kanban-board.ts"), "utf-8");
    const match = board.match(/export function kanbanUpdate\([^)]*fields: ([^)]+)\)/);
    expect(match).not.toBeNull();
    const fieldType = match![1]!;
    expect(fieldType).toContain("Partial<Pick<KanbanCard,");
    expect(fieldType).not.toMatch(/\bstatus\b/);
  });

  it("every raw writer enumerated in the spec is gone from production files", () => {
    // Anchors from specs/1590/requirements.md — any hit means a raw
    // kanban_board status write survived the refactor.
    const anchors: Array<[string, string]> = [
      ["src/components/pi-executor/pi-run-store.ts", "UPDATE kanban_board SET status = 'done'"],
      ["src/components/pi-executor/pi-run-store.ts", "UPDATE kanban_board SET status = 'failed'"],
      ["src/components/pi-executor/pi-run-store.ts", "UPDATE kanban_board SET status = 'queued'"],
      ["src/components/project-acceptance/project-review-store.ts", "UPDATE kanban_board SET status = ?"],
      ["src/components/reconciler.ts", "UPDATE kanban_board SET status = 'failed'"],
      ["src/cli/commands/doctor-fixes.ts", "SET status = 'failed'"],
    ];
    for (const [rel, needle] of anchors) {
      const content = readFileSync(join(SRC_ROOT, "..", rel), "utf-8");
      expect(content, `raw status write survived in ${rel}`).not.toContain(needle);
    }
  });
});
