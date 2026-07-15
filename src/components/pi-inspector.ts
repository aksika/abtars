/**
 * pi-inspector.ts — Bounded Pi component inspection (#1427).
 *
 * Inspects installed Pi packages (pi-ai, pi-tui) by reading their
 * package.json from the shared npm prefix, and probes the configured
 * pi-coding-agent executable with `--version`.
 *
 * Never loads Pi implementation modules.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { PI_COMPATIBILITY } from "../config/pi-compatibility.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const PI_VERSION_PROBE_TIMEOUT_MS = 5_000;
export const PI_VERSION_PROBE_MAX_BYTES = 1024;

// ── Types ─────────────────────────────────────────────────────────────────────

export type PiComponentId = "ai" | "tui" | "coding-agent";

export type PiComponentStatus = {
  component: PiComponentId;
  expected: string;
  observed?: string;
  state: "ok" | "missing" | "mismatch" | "invalid";
  path?: string;
  remediation?: string;
};

// ── Shared nm dir ─────────────────────────────────────────────────────────────

function resolveNmDir(): string {
  return process.env["ABTARS_NM"] ?? join(homedir(), ".local", "lib", "node_modules");
}

// ── Package inspection ────────────────────────────────────────────────────────

export function inspectPiPackage(component: "ai" | "tui"): PiComponentStatus {
  const info = PI_COMPATIBILITY.packages[component];
  const pkgDir = join(resolveNmDir(), info.name);
  const pkgJsonPath = join(pkgDir, "package.json");

  if (!existsSync(pkgJsonPath)) {
    return {
      component,
      expected: info.version,
      state: "missing",
      remediation: `Install with: abtars deps install ${component === "ai" ? "provider" : "tui"}`,
    };
  }

  try {
    const raw = readFileSync(pkgJsonPath, "utf-8");
    const meta = JSON.parse(raw) as { version?: string };
    if (typeof meta.version !== "string" || !meta.version) {
      return {
        component,
        expected: info.version,
        state: "invalid",
        path: pkgJsonPath,
        remediation: `Corrupt installation. Reinstall with: abtars deps install ${component === "ai" ? "provider" : "tui"}`,
      };
    }
    if (meta.version !== info.version) {
      return {
        component,
        expected: info.version,
        observed: meta.version,
        state: "mismatch",
        path: pkgJsonPath,
        remediation: `Expected ${info.version}, found ${meta.version}. Update with: abtars deps update ${component === "ai" ? "provider" : "tui"}`,
      };
    }
    return {
      component,
      expected: info.version,
      observed: meta.version,
      state: "ok",
      path: pkgJsonPath,
    };
  } catch {
    return {
      component,
      expected: info.version,
      state: "invalid",
      path: pkgJsonPath,
      remediation: `Corrupt package.json. Reinstall with: abtars deps install ${component === "ai" ? "provider" : "tui"}`,
    };
  }
}

// ── Executable probe ──────────────────────────────────────────────────────────

export function probePiExecutable(command: string): PiComponentStatus {
  const info = PI_COMPATIBILITY.packages.codingAgent;
  const result = spawnSync(command, ["--version"], {
    shell: false,
    encoding: "utf-8",
    timeout: PI_VERSION_PROBE_TIMEOUT_MS,
    maxBuffer: PI_VERSION_PROBE_MAX_BYTES,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        component: "coding-agent",
        expected: info.version,
        state: "missing",
        path: command,
        remediation: remediationForExecutable(command, info.version),
      };
    }
    return {
      component: "coding-agent",
      expected: info.version,
      state: "invalid",
      path: command,
      remediation: remediationForExecutable(command, info.version),
    };
  }

  if (result.signal || result.status !== 0) {
    return {
      component: "coding-agent",
      expected: info.version,
      state: "invalid",
      path: command,
      remediation: remediationForExecutable(command, info.version),
    };
  }

  const stdout = (result.stdout ?? "").trim();
  if (!stdout || stdout.length > 100) {
    return {
      component: "coding-agent",
      expected: info.version,
      state: "invalid",
      path: command,
      remediation: remediationForExecutable(command, info.version),
    };
  }

  if (stdout !== info.version) {
    return {
      component: "coding-agent",
      expected: info.version,
      observed: stdout,
      state: "mismatch",
      path: command,
      remediation: remediationForExecutable(command, info.version),
    };
  }

  return {
    component: "coding-agent",
    expected: info.version,
    observed: stdout,
    state: "ok",
    path: command,
  };
}

function remediationForExecutable(command: string, expectedVersion: string): string {
  if (command.includes("pi-coding-agent") || command.includes("node_modules")) {
    return `Install with: npm install -g @earendil-works/pi-coding-agent@${expectedVersion}`;
  }
  return `Install the exact target version (${expectedVersion}) and update pi-executor.json 'command'`;
}

// ── Composite inspection ──────────────────────────────────────────────────────

export function inspectAllPiComponents(config: { command?: string }): PiComponentStatus[] {
  const results: PiComponentStatus[] = [
    inspectPiPackage("ai"),
    inspectPiPackage("tui"),
  ];

  if (config.command) {
    results.push(probePiExecutable(config.command));
  } else {
    results.push({
      component: "coding-agent",
      expected: PI_COMPATIBILITY.packages.codingAgent.version,
      state: "missing",
      remediation: "Pi executor not configured. Set 'command' in pi-executor.json",
    });
  }

  return results;
}
