/**
 * Hook system — loads config, fires events to shell-script hooks.
 * Sequential execution, first-block-wins on BeforeMessage, log-and-skip on failure.
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logInfo, logWarn, logDebug } from "../logger.js";
import type { HookConfig, HookEntry, HookEvent, HookInput, HookOutput } from "./types.js";

const TAG = "hooks";
const DEFAULT_TIMEOUT = 5000;

let config: HookConfig | null = null;

export function loadHookConfig(): void {
  const configPath = join(homedir(), ".agentbridge", "config", "hooks.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as HookConfig;
    if (!parsed.enabled) {
      config = null;
      logDebug(TAG, "Hooks disabled in config");
      return;
    }
    // Permission check on hooks dir
    const hooksDir = join(homedir(), ".agentbridge", "hooks");
    try {
      const st = statSync(hooksDir);
      const mode = st.mode & 0o777;
      if (mode !== 0o700) {
        logWarn(TAG, `Hooks dir ${hooksDir} has mode ${mode.toString(8)}, expected 700 — hooks disabled`);
        config = null;
        return;
      }
    } catch {
      // Dir doesn't exist — that's fine, hooks just won't find scripts there
    }
    config = parsed;
    const count = Object.values(parsed.hooks).reduce((n, arr) => n + (arr?.length ?? 0), 0);
    logInfo(TAG, `Loaded ${count} hook(s) from ${configPath}`);
  } catch {
    config = null;
    logDebug(TAG, "No hooks.json found — hooks disabled");
  }
}

export function hasHooks(event: HookEvent): boolean {
  return (config?.hooks[event]?.length ?? 0) > 0;
}

export function getHookSummary(): Array<{ event: HookEvent; hooks: HookEntry[] }> {
  const events: HookEvent[] = ["BridgeStart", "BeforeMessage", "AfterMessage", "SessionStart", "SessionEnd", "AfterPrompt"];
  return events.map(event => ({ event, hooks: config?.hooks[event] ?? [] }));
}

export async function fire(event: HookEvent, input: HookInput): Promise<HookOutput | null> {
  const hooks = config?.hooks[event];
  if (!hooks?.length) return null;

  for (const hook of hooks) {
    try {
      const result = await runOne(hook, input);
      if (result?.decision === "block" && event === "BeforeMessage") {
        logInfo(TAG, `${event}/${hook.name}: BLOCKED — ${result.reason ?? "no reason"}`);
        return result;
      }
    } catch (err) {
      logWarn(TAG, `${event}/${hook.name} failed: ${err instanceof Error ? err.message : String(err)} — skipping`);
    }
  }
  return null;
}

function runOne(hook: HookEntry, input: HookInput): Promise<HookOutput | null> {
  const timeout = hook.timeout ?? DEFAULT_TIMEOUT;
  return new Promise((resolve) => {
    const child = spawn(hook.command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      env: {
        AGENT_BRIDGE_HOME: join(homedir(), ".agentbridge"),
        ABMIND_HOME: join(homedir(), ".abmind"),
        PATH: process.env["PATH"] ?? "",
      },
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const MAX_STDOUT = 1_048_576;
    const MAX_STDERR = 65_536;
    child.stdout?.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_STDOUT) { child.kill("SIGTERM"); logWarn(TAG, `${hook.name} stdout exceeded 1MB — killed`); return; }
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderrBytes > MAX_STDERR) return;
      stderrBytes += d.length;
      stderr += d.toString();
    });

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1000);
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (stderr.trim()) logDebug(TAG, `${hook.name} stderr: ${stderr.trim().slice(0, 200)}`);
      if (code !== 0) {
        logDebug(TAG, `${hook.name} exited ${code}`);
        resolve(null);
        return;
      }
      if (!stdout.trim()) { resolve(null); return; }
      try {
        resolve(JSON.parse(stdout.trim()) as HookOutput);
      } catch {
        logDebug(TAG, `${hook.name} non-JSON output: ${stdout.trim().slice(0, 100)}`);
        resolve(null);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      logWarn(TAG, `${hook.name} spawn error: ${err.message}`);
      resolve(null);
    });

    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}
