import { spawnSync } from "node:child_process";
import { existsSync, accessSync, readFileSync, constants } from "node:fs";
import { abtarsHome } from "../../paths.js";
import { resolvePiFromPath } from "../../components/pi-installation.js";
import { join } from "node:path";

// #1476: Pi can take >3s to start under boot load (interpreted launcher) —
// too low a timeout caused transient "failed" states in doctor.
const TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 1024;

export interface PiVersionResult {
  found: boolean;
  version?: string;
  error?: string;
}

function resolvePi(): string | null {
  const executorPath = join(abtarsHome(), "config", "pi-executor.json");
  try {
    const config = JSON.parse(readFileSync(executorPath, "utf-8")) as { command?: string };
    if (config.command && existsSync(config.command)) {
      try { accessSync(config.command, constants.X_OK); return config.command; } catch { /* fall through */ }
    }
  } catch { /* no config, use PATH */ }
  return resolvePiFromPath();
}

export function getPiVersion(): PiVersionResult {
  const piPath = resolvePi();
  if (!piPath) return { found: false };

  try {
    const result = spawnSync(piPath, ["--version"], {
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { found: false };
      // #1476: timeout is transient (slow startup), not a hard failure.
      if (code === "ETIMEDOUT") return { found: false, error: "timed out" };
      return { found: false, error: code ? `spawn error: ${code}` : result.error.message };
    }

    if (result.signal) return { found: false, error: `killed by signal ${result.signal}` };
    if (result.status !== null && result.status !== 0) return { found: false, error: `exited with code ${result.status}` };

    const output = (result.stdout ?? "").trim() || (result.stderr ?? "").trim();
    if (!output) return { found: false, error: "empty output" };

    const normalized = output.replace(/^v/i, "").trim();
    if (/^\d+\.\d+\.\d+/.test(normalized)) return { found: true, version: normalized };
    return { found: false, error: "unrecognized output" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timed out") || (err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { found: false, error: "timed out" };
    }
    return { found: false, error: msg };
  }
}
