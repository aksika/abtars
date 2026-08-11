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
});
