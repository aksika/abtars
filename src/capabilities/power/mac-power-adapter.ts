import type { PowerAdapter, WakeVerification, FixedCommandRunner } from "./types.js";
import { parsePmsetSchedOutput } from "./pmset-parser.js";

function assertRealSuspendAllowed(env: NodeJS.ProcessEnv): void {
  if (env.VITEST || env.NODE_ENV === "test") {
    throw new Error("hardware suspend disabled under test runtime");
  }
}

export class MacPowerAdapter implements PowerAdapter {
  readonly platform = "darwin" as const;

  constructor(private readonly run: FixedCommandRunner) {}

  async verifyWakeSchedule(expectedLocalTime: string): Promise<WakeVerification> {
    const { stdout, exitCode } = await this.run("/usr/bin/pmset", ["-g", "sched"]);
    if (exitCode !== 0) {
      return { verified: false, reason: `pmset exited ${exitCode}` };
    }
    return parsePmsetSchedOutput(stdout, expectedLocalTime);
  }

  async suspend(): Promise<void> {
    assertRealSuspendAllowed(process.env);
    const { exitCode, stderr } = await this.run("/usr/bin/pmset", ["sleepnow"]);
    if (exitCode !== 0) {
      throw new Error(`pmset sleepnow failed (exit ${exitCode}): ${stderr}`);
    }
  }
}
