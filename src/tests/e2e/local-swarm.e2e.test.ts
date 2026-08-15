import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

type LocalSwarmResultV2 = {
  schemaVersion: 2;
  ok: boolean;
  scenario: string;
  scenarioId: string;
  projectCardId?: number;
  childCardIds: number[];
  peakActiveWorkers: number;
  counts: {
    workerContracts: number;
    workerAttempts: number;
    workerResults: number;
    reviewCases: number;
    reviewDecisions: number;
    outboundDeliveries: number;
  };
  terminal: { projectState?: string; cardStatus?: string; deliveryResult?: string };
  duplicateWakeStable?: boolean;
  failure?: { stage: string; code: string; message: string };
  scenarioSpecific?: Record<string, unknown>;
};

const MAX_OUTPUT = 16_000;
const CHILD_TIMEOUT_MS = 75_000;

function boundedAppend(current: string, next: Buffer | string): string {
  const value = current + next.toString();
  return value.length <= MAX_OUTPUT ? value : value.slice(-MAX_OUTPUT);
}

function readTrace(root: string): string[] {
  const logDir = join(root, "abtars-home", "logs");
  try {
    return readdirSync(logDir)
      .filter(name => name.endsWith(".log"))
      .flatMap(name => readFileSync(join(logDir, name), "utf8").split("\n"))
      .filter(line => {
        try { return (JSON.parse(line) as { tag?: string }).tag === "swarm-trace"; } catch { return false; }
      })
      .slice(-80);
  } catch {
    return [];
  }
}

async function runChild(root: string, scenario: string): Promise<{ result?: LocalSwarmResultV2; stdout: string; stderr: string; trace: string[] }> {
  const home = join(root, "abtars-home");
  const runner = join(process.cwd(), "src/tests/e2e/local-swarm-runner.ts");
  const child = spawn(process.execPath, ["--import", "tsx", runner], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      NODE_ENV: "test",
      ABTARS_HOME: home,
      LOG_FORMAT: "json",
      ABTARS_LOG_LEVEL: "trace",
      SCENARIO: scenario,
      NODE_PATH: process.env["NODE_PATH"] ?? (process.env["HOME"] ? join(process.env["HOME"], ".local/lib/node_modules") : ""),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout = boundedAppend(stdout, chunk); });
  child.stderr.on("data", chunk => { stderr = boundedAppend(stderr, chunk); });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    let exited = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2_000).unref();
    }, CHILD_TIMEOUT_MS);
    child.once("exit", (code, signal) => { exited = true; clearTimeout(timer); resolve({ code, signal }); });
  });

  const resultLine = stdout.split("\n").find(line => line.startsWith("LOCAL_SWARM_RESULT="));
  let result: LocalSwarmResultV2 | undefined;
  if (resultLine) {
    try { result = JSON.parse(resultLine.slice("LOCAL_SWARM_RESULT=".length)) as LocalSwarmResultV2; } catch {}
  }
  if (!result || exit.code !== 0) {
    const detail = [
      `child exit code=${exit.code ?? "null"} signal=${exit.signal ?? "none"}`,
      result ? `child failure=${JSON.stringify(result.failure)}` : "missing or malformed LOCAL_SWARM_RESULT",
      `stderr=${stderr.slice(-2_000)}`,
      `trace=${JSON.stringify(readTrace(root))}`,
    ].join("\n");
    throw new Error(detail);
  }
  return { result, stdout, stderr, trace: readTrace(root) };
}

async function runScenario(scenario: string, scenarioFn: (result: LocalSwarmResultV2) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `abtars-swarm-${scenario}-`));
  try {
    const run = await runChild(root, scenario);
    const result = run.result!;
    scenarioFn(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Local Swarm E2E", () => {
  it("happy_path: proves the real three-Worker production journey and exactly-once replay", async () => {
    await runScenario("happy_path", (result) => {
      expect(result.ok).toBe(true);
      expect(result.childCardIds).toHaveLength(3);
      expect(result.peakActiveWorkers).toBe(3);
      expect(result.counts).toEqual({
        workerContracts: 3,
        workerAttempts: 3,
        workerResults: 3,
        reviewCases: 1,
        reviewDecisions: 1,
        outboundDeliveries: 1,
      });
      expect(result.terminal).toEqual({ projectState: "accepted", cardStatus: "delivered", deliveryResult: "sent" });
      expect(result.duplicateWakeStable).toBe(true);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("restart_recovery: terminates predecessor after bridge restart, starts at most one successor", async () => {
    await runScenario("restart_recovery", (result) => {
      expect(result.ok).toBe(true);
      expect(result.childCardIds).toHaveLength(1);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.finalLifecycle).toMatch(/completed|timed_out/);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("capacity_deadline: peak durable active <= 3, deadline expiration, late result rejection", async () => {
    await runScenario("capacity_deadline", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(Number(ss.peakDurableActive)).toBeGreaterThan(0);
      expect(Number(ss.peakDurableActive)).toBeLessThanOrEqual(3);
      expect(Number(ss.attemptedDeadlines)).toBeGreaterThan(0);
      expect(ss.lateResultRejected).toBe(true);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("priority_age: aged LOW card runs under sustained top-priority arrivals", async () => {
    await runScenario("priority_age", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.agedCardStarted).toBe(true);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("scheduled_cap: durable maxAgents cap admits three Workers, refuses the fourth, releases on terminal", async () => {
    await runScenario("scheduled_cap", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.admitted).toBe(3);
      expect(ss.childrenBeforeRelease).toBe(3);
      expect(String(ss.refusal)).toContain("agent_cap_reached");
      expect(Number(ss.admittedAfterRelease)).toBeGreaterThan(0);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("token_budget: capped project enforces reservations and exhaustion", async () => {
    await runScenario("token_budget", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(Number(ss.totalTokensUsed)).toBeLessThanOrEqual(Number(ss.projectMaxTokens ?? 20000));
      expect(Number(ss.terminalChildren)).toBeGreaterThan(0);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("pi_coding (#1638): alias contract routes to Pi, settles through the Worker lane, Orc accepts and delivers once", async () => {
    await runScenario("pi_coding", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.piAttemptExecutor).toBe("pi/pi-coding");
      expect(ss.piRunStatus).toBe("completed");
      expect(ss.piProvenance).toBe("pi");
      expect(ss.workspaceClaimsReleased).toBe(true);
      expect(result.terminal.projectState).toBe("accepted");
      expect(result.terminal.cardStatus).toBe("delivered");
      expect(result.counts.outboundDeliveries).toBe(1);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("pi_spin_route (#1638 Gate A S2): no-alias contract runs the existing Spin path even with Pi live", async () => {
    await runScenario("pi_spin_route", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.spinAttemptExecutor).toBe("agent/spin-local");
      expect(ss.spinProvenance).toBe("agent");
      expect(Number(ss.piRunsCreated)).toBe(0);
      expect(Number(ss.workspaceClaims)).toBe(0);
      expect(result.terminal.projectState).toBe("accepted");
      expect(result.counts.outboundDeliveries).toBe(1);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("pi_unavailable (#1638 Gate A S3): coding child fails closed with a stated reason and zero orphans", async () => {
    await runScenario("pi_unavailable", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.attemptLifecycle).toBe("failed");
      expect(String(ss.failureReason)).toContain("pi_executor_unavailable");
      expect(String(ss.executor)).toContain("pi/");
      expect(Number(ss.piRuns)).toBe(0);
      expect(Number(ss.claims)).toBe(0);
      expect(Number(ss.piCards)).toBe(0);
      expect(ss.cardStatus).toBe("failed");
      expect(result.counts.workerResults).toBeGreaterThan(0);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("pi_workspace_contention (#1638 Gate A S4): same canonical path via two aliases serializes; waiter defers without spending a retry", async () => {
    await runScenario("pi_workspace_contention", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.attemptBWhileBusy).toBe("pending");
      expect(Number(ss.attemptsForB)).toBe(1);
      expect(Number(ss.peakConcurrentPerPath)).toBe(1);
      expect(ss.claimsReleased).toBe(true);
      expect(result.counts.workerAttempts).toBe(2);
      expect(result.terminal.projectState).toBe("accepted");
      expect(result.counts.outboundDeliveries).toBe(1);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("pi_standalone_capacity (#1648 Gate A S4b): second standalone run stays paired-queued, survives the Spin legacy drain, starts on release", async () => {
    await runScenario("pi_standalone_capacity", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.secondRunWhileBusy).toBe("queued");
      expect(ss.secondCardWhileBusy).toBe("queued");
      expect(ss.survivedDrain).toBe(true);
      expect(ss.firstFinalStatus).toBe("completed");
      expect(ss.secondFinalStatus).toBe("completed");
      expect(ss.secondCardFinalStatus).toBe("done");
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("pi_replay_stale (#1638 Gate A S5): terminal replay and a stale generation settle exactly once", async () => {
    await runScenario("pi_replay_stale", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.piRunStatus).toBe("completed");
      expect(ss.piProvenance).toBe("pi");
      expect(result.counts.workerResults).toBe(1);
      expect(result.counts.workerAttempts).toBe(1);
      expect(result.counts.outboundDeliveries).toBe(1);
      expect(result.terminal.projectState).toBe("accepted");
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("pi_input_answer (#1638 Gate A S6): live question → structured zero-charge evidence → Orc answer → resumed retry", async () => {
    await runScenario("pi_input_answer", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.firstLifecycle).toBe("failed");
      expect(Number(ss.chargedTokens)).toBe(0);
      expect(ss.questionEvidenceCode).toBe("INPUT_REQUESTED");
      expect(ss.runStatusAfterQuestion).toBe("interrupted");
      expect(ss.resumeCapability).toBe("available");
      expect(Number(ss.attempts)).toBe(2);
      expect(ss.retryContinuity).toBe("resumed");
      expect(Number(ss.retryGeneration)).toBe(2);
      expect(ss.retryRunStatus).toBe("completed");
      expect(result.terminal.projectState).toBe("accepted");
      expect(result.counts.outboundDeliveries).toBe(1);
    });
  }, CHILD_TIMEOUT_MS + 10_000);

  it("pi_ask_orc (#1643): real ask_orc UI frame → placeholder question evidence → zero-charge suspension → Orc answer → resumed retry", async () => {
    await runScenario("pi_ask_orc", (result) => {
      expect(result.ok).toBe(true);
      const ss = result.scenarioSpecific as Record<string, unknown>;
      expect(ss).toBeDefined();
      expect(ss.firstLifecycle).toBe("failed");
      expect(Number(ss.chargedTokens)).toBe(0);
      expect(ss.questionEvidenceCode).toBe("INPUT_REQUESTED");
      expect(ss.questionFromPlaceholder).toBe(true);
      expect(ss.runStatusAfterQuestion).toBe("interrupted");
      expect(ss.resumeCapability).toBe("available");
      expect(Number(ss.attempts)).toBe(2);
      expect(ss.retryContinuity).toBe("resumed");
      expect(Number(ss.retryGeneration)).toBe(2);
      expect(ss.retryRunStatus).toBe("completed");
      expect(result.terminal.projectState).toBe("accepted");
      expect(result.counts.outboundDeliveries).toBe(1);
    });
  }, CHILD_TIMEOUT_MS + 10_000);
});
