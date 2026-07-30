import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

type LocalSwarmResult = {
  schemaVersion: 1;
  ok: boolean;
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

async function runChild(root: string): Promise<{ result?: LocalSwarmResult; stdout: string; stderr: string; trace: string[] }> {
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
      NODE_PATH: process.env["NODE_PATH"] ?? (process.env["HOME"] ? join(process.env["HOME"], ".local/lib/node_modules") : ""),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout = boundedAppend(stdout, chunk); });
  child.stderr.on("data", chunk => { stderr = boundedAppend(stderr, chunk); });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2_000).unref();
      resolve({ code: null, signal: "SIGTERM" });
    }, CHILD_TIMEOUT_MS);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });

  const resultLine = stdout.split("\n").find(line => line.startsWith("LOCAL_SWARM_RESULT="));
  let result: LocalSwarmResult | undefined;
  if (resultLine) {
    try { result = JSON.parse(resultLine.slice("LOCAL_SWARM_RESULT=".length)) as LocalSwarmResult; } catch { /* assertion below reports malformed protocol */ }
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

describe("Local Swarm E2E", () => {
  it("proves the real three-Worker production journey and exactly-once replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "abtars-swarm-e2e-"));
    try {
      const run = await runChild(root);
      const result = run.result!;
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHILD_TIMEOUT_MS + 10_000);
});
