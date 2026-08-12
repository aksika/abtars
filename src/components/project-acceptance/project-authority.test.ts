import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let ProjectReviewStore: typeof import("./project-review-store.js").ProjectReviewStore;
let authorizeActiveProjectWork: typeof import("./project-review-store.js").authorizeActiveProjectWork;
let authorizeProjectDelivery: typeof import("./project-review-store.js").authorizeProjectDelivery;
let kanbanEnqueue: typeof import("../tasks/kanban-board.js").kanbanEnqueue;
let db: import("../tasks/kanban-board.js").TaskDatabase;

let scheduledRootId: number;
let plainRootId: number;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `project-authority-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const reviewMod = await import("./project-review-store.js");
  ProjectReviewStore = reviewMod.ProjectReviewStore;
  authorizeActiveProjectWork = reviewMod.authorizeActiveProjectWork;
  authorizeProjectDelivery = reviewMod.authorizeProjectDelivery;
  const kanbanMod = await import("../tasks/kanban-board.js");
  kanbanEnqueue = kanbanMod.kanbanEnqueue;
  db = kanbanMod.requireTaskDatabase();

  // Scheduled project root: task-sourced with a live run row.
  scheduledRootId = kanbanEnqueue("Scheduled project", "task", "run-1644", { type: "O" });
  db.prepare(`
    INSERT INTO task_runs (run_id, task_id, group_id, attempt, trigger, occurrence_at, reserved_at, deadline_at, phase, last_progress_at, owner_pid)
    VALUES ('run-1644', 'task-1644', 'g-1644', 1, 'schedule', 0, 0, 9999999999999, 'executing', 0, 1)
  `).run();

  // Plain (non-scheduled) project root.
  plainRootId = kanbanEnqueue("Plain project", "test", undefined, { type: "O" });
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

function supervisionState(rootId: number): { state: string; generation: number } {
  return db.prepare(`SELECT state, generation FROM project_supervision WHERE project_card_id = ?`).get(rootId) as { state: string; generation: number };
}

function setState(rootId: number, state: string, generation = 1): void {
  const review = new ProjectReviewStore();
  if (supervisionState(rootId)) {
    review.setState(rootId, state as never);
    if (generation !== 1) review.incrementGeneration(rootId);
  } else {
    review.initializeSupervision(rootId, `pc_${rootId}`, state as never);
    if (generation !== 1) review.incrementGeneration(rootId);
  }
}

function failRun(runId: string): void {
  db.prepare(`UPDATE task_runs SET finished_at = ?, outcome = 'failed' WHERE run_id = ?`).run(Date.now(), runId);
}

function succeedRun(runId: string): void {
  db.prepare(`UPDATE task_runs SET finished_at = ?, outcome = 'success' WHERE run_id = ?`).run(Date.now(), runId);
}

function liveRun(runId: string): void {
  db.prepare(`UPDATE task_runs SET finished_at = NULL, outcome = NULL WHERE run_id = ?`).run(runId);
}

describe("#1644 project authority predicates", () => {
  describe("authorizeActiveProjectWork", () => {
    it("authorizes a live scheduled project at the exact generation/run", () => {
      setState(scheduledRootId, "executing");
      expect(authorizeActiveProjectWork(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBeNull();
    });

    it("authorizes a live non-scheduled project without a run identity", () => {
      setState(plainRootId, "executing");
      expect(authorizeActiveProjectWork(db, { projectCardId: plainRootId, projectGeneration: 1 })).toBeNull();
    });

    it("rejects a blocked root", () => {
      setState(scheduledRootId, "blocked");
      expect(authorizeActiveProjectWork(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("project_terminal");
    });

    it("rejects an accepted root", () => {
      setState(scheduledRootId, "accepted");
      expect(authorizeActiveProjectWork(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("project_terminal");
    });

    it("rejects a project-generation mismatch", () => {
      setState(scheduledRootId, "executing", 2);
      expect(authorizeActiveProjectWork(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("generation_mismatch");
    });

    it("rejects a missing authority tuple", () => {
      expect(authorizeActiveProjectWork(db, undefined)).toBe("missing_authority");
      expect(authorizeActiveProjectWork(db, { projectCardId: 0, projectGeneration: 1 })).toBe("missing_authority");
      expect(authorizeActiveProjectWork(db, { projectCardId: plainRootId, projectGeneration: NaN })).toBe("missing_authority");
    });

    it("rejects a missing project root or non-project card", () => {
      expect(authorizeActiveProjectWork(db, { projectCardId: 999_999, projectGeneration: 1 })).toBe("project_missing");
      const workerCard = kanbanEnqueue("Worker", "test", undefined, { type: "W", parent_id: plainRootId });
      expect(authorizeActiveProjectWork(db, { projectCardId: workerCard, projectGeneration: 1 })).toBe("project_missing");
    });

    it("rejects a run mismatch (run id does not match the root's source_id)", () => {
      setState(scheduledRootId, "executing");
      expect(authorizeActiveProjectWork(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-other" })).toBe("run_mismatch");
      // a run id supplied for a non-scheduled root is also a mismatch
      setState(plainRootId, "executing");
      expect(authorizeActiveProjectWork(db, { projectCardId: plainRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("run_mismatch");
    });

    it("rejects a missing task_runs row", () => {
      const broken = kanbanEnqueue("Scheduled no run row", "task", "run-ghost", { type: "O" });
      setState(broken, "executing");
      expect(authorizeActiveProjectWork(db, { projectCardId: broken, projectGeneration: 1, scheduledRunId: "run-ghost" })).toBe("run_mismatch");
    });

    it("rejects a scheduled root without a run identity", () => {
      setState(scheduledRootId, "executing");
      expect(authorizeActiveProjectWork(db, { projectCardId: scheduledRootId, projectGeneration: 1 })).toBe("run_mismatch");
    });

    it("rejects work on a terminally settled run (run_failed)", () => {
      setState(scheduledRootId, "executing");
      failRun("run-1644");
      expect(authorizeActiveProjectWork(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("run_failed");
    });
  });

  describe("authorizeProjectDelivery", () => {
    it("authorizes an accepted scheduled project with a successful terminal run", () => {
      setState(scheduledRootId, "accepted");
      succeedRun("run-1644");
      expect(authorizeProjectDelivery(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBeNull();
    });

    it("authorizes an accepted non-scheduled project without a run identity", () => {
      setState(plainRootId, "accepted");
      expect(authorizeProjectDelivery(db, { projectCardId: plainRootId, projectGeneration: 1 })).toBeNull();
    });

    it("rejects delivery for a blocked root", () => {
      setState(scheduledRootId, "blocked");
      succeedRun("run-1644");
      expect(authorizeProjectDelivery(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("project_terminal");
    });

    it("rejects delivery while the project is still live", () => {
      setState(scheduledRootId, "executing");
      succeedRun("run-1644");
      expect(authorizeProjectDelivery(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("project_terminal");
    });

    it("rejects delivery for a live (unsettled) run", () => {
      setState(scheduledRootId, "accepted");
      liveRun("run-1644");
      expect(authorizeProjectDelivery(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("run_failed");
    });

    it("rejects delivery for a failed run", () => {
      setState(scheduledRootId, "accepted");
      failRun("run-1644");
      expect(authorizeProjectDelivery(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("run_failed");
    });

    it("rejects a run mismatch — a claim for run N cannot authorize run N+1", () => {
      setState(scheduledRootId, "accepted");
      succeedRun("run-1644");
      expect(authorizeProjectDelivery(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1645" })).toBe("run_mismatch");
    });

    it("rejects a generation mismatch at delivery time", () => {
      setState(scheduledRootId, "accepted", 2);
      succeedRun("run-1644");
      expect(authorizeProjectDelivery(db, { projectCardId: scheduledRootId, projectGeneration: 1, scheduledRunId: "run-1644" })).toBe("generation_mismatch");
    });
  });
});
