/**
 * Real `abtars tui` smoke. The protocol client covers bridge frames, but only
 * this helper exercises the terminal renderer, PTY, keyboard input, and clean
 * interactive exit against the installed Pi presentation packages.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { BridgeConfigResult } from "./bridge-config.js";
import { SpawnedChild, waitFor } from "./child-process.js";
import type { PiAcceptanceLane } from "./contracts.js";
import { TIMEOUTS } from "./contracts.js";
import type { ScriptedProvider } from "./scripted-provider.js";

interface InteractiveTuiSmokeOptions {
  abtarsRoot: string;
  config: BridgeConfigResult;
  lane: PiAcceptanceLane;
  logDir: string;
  provider: ScriptedProvider;
  runId: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function visibleText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\r/g, "");
}

function scriptArgs(command: string): string[] {
  // util-linux (Linux) and BSD (macOS) have different command placement.
  return process.platform === "darwin"
    ? ["-q", "/dev/null", command]
    : ["-qfec", command, "/dev/null"];
}

export async function runInteractiveTuiSmoke(opts: InteractiveTuiSmokeOptions): Promise<void> {
  try {
    // BSD `script` has no `--version`; exercise the platform-specific command
    // shape so the prerequisite check works on both macOS and Linux.
    execFileSync("script", scriptArgs(":"), { stdio: "ignore", timeout: 5_000 });
  } catch {
    throw new Error("interactive TUI smoke requires the `script` pseudo-terminal utility");
  }

  const command = [
    "stty raw -echo && exec",
    shellQuote(process.execPath),
    shellQuote(resolve(opts.abtarsRoot, "bundle/abtars-cli.js")),
    "tui --new A",
  ].join(" ");
  const child = new SpawnedChild({
    execPath: "script",
    args: scriptArgs(command),
    cwd: opts.abtarsRoot,
    env: {
      ...opts.config.bridgeEnv,
      TERM: "xterm-256color",
    },
    logDir: opts.logDir,
    name: `tui-renderer-${opts.lane}`,
    input: true,
  });
  const stdoutLogPath = join(opts.logDir, `tui-renderer-${opts.lane}.stdout.log`);
  const output = (): string => {
    try {
      return readFileSync(stdoutLogPath, "utf-8").slice(-64 * 1024);
    } catch {
      return child.stdoutTail;
    }
  };

  try {
    await waitFor(
      async () => {
        if (child.exited) throw new Error(`abtars tui exited before becoming interactive (code=${child.exitCodeValue}, signal=${child.signalValue})\n${child.stderrTail}`);
        return visibleText(output()).length > 0 ? true : undefined;
      },
      TIMEOUTS.bridgeReadinessMs,
      "interactive abtars tui startup",
      () => `${output()}\n${child.stderrTail}`,
    );

    const baselineRequests = opts.provider.summaries.length;
    const marker = `PI-TUI-SMOKE-${opts.runId}`;
    const reply = `PI-TUI-SMOKE-OK-${opts.runId}`;
    opts.provider.enqueue({ candidate: "fixture-model-a", expectation: undefined, action: { kind: "text", chunks: [reply] } });
    // pi-tui's raw terminal input maps carriage return to Enter. A line-feed
    // is echoed by the editor but does not submit the current draft.
    child.stdin.write(`${marker}\r`);

    await waitFor(
      async () => opts.provider.summaries
        .slice(baselineRequests)
        .some((summary) => summary.markerTexts.some((text) => text.includes(marker))) ? true : undefined,
      TIMEOUTS.turnMs,
      "interactive TUI provider request",
      () => `${output()}\n${child.stderrTail}`,
    );
    await waitFor(
      async () => visibleText(output()).includes(reply) ? true : undefined,
      TIMEOUTS.turnMs,
      "interactive TUI rendered reply",
      () => `${output()}\n${child.stderrTail}`,
    );

    child.stdin.write("/exit\r");
    const exit = await child.waitForExit(TIMEOUTS.childGraceMs);
    if (exit.exitCode !== 0) {
      throw new Error(`abtars tui exited with code ${exit.exitCode ?? "unknown"}: ${exit.stderrTail}`);
    }
  } finally {
    if (!child.exited) await child.terminate();
  }
}
