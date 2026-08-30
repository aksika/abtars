/**
 * Component-level Pi runtime report for the production canary.
 *
 * One disposable Pi installation is loaded once and every abtars-consumed
 * runtime surface is checked independently. The report is diagnostic; the
 * combined production E2E remains the release gate.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type { PiInstallation, PiModuleSpecifier } from "../../../components/pi-installation.js";
import { loadPiModule, resolvePiInstallation } from "../../../components/pi-installation.js";
import {
  REQUIRED_PI_CODING_AGENT_EXPORTS,
  REQUIRED_PI_TUI_EXPORTS,
} from "../../../cli/commands/tui-runtime-contract.js";
import type { PiRuntimeCheck, PiRuntimeReport } from "./contracts.js";

const API_FAMILIES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

const REQUIRED_AGENT_METHODS = [
  "subscribe", "prompt", "steer", "followUp",
  "clearAllQueues", "abort", "waitForIdle",
] as const;

type RuntimeModule = Record<string, unknown>;

function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function check(
  checks: PiRuntimeCheck[],
  component: string,
  capability: string,
  passed: boolean,
  detail?: string,
): void {
  checks.push({
    component,
    capability,
    state: passed ? "passed" : "failed",
    ...(detail ? { detail } : {}),
  });
}

function packageRoots(installation: PiInstallation): Record<string, string> {
  return {
    "pi-coding-agent": installation.packageRoot,
    "pi-ai": installation.moduleRoots.ai,
    "pi-tui": installation.moduleRoots.tui,
    "pi-agent-core": installation.moduleRoots.agentCore,
  };
}

function readPackageVersions(
  installation: PiInstallation,
  checks: PiRuntimeCheck[],
): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const [label, root] of Object.entries(packageRoots(installation))) {
    try {
      const packageJson = JSON.parse(readFileSync(`${root}/package.json`, "utf-8")) as { name?: unknown; version?: unknown };
      const valid = packageJson.name === `@earendil-works/${label}` && typeof packageJson.version === "string";
      if (valid) versions[label] = packageJson.version as string;
      check(
        checks,
        "package-graph",
        `${label}:package-metadata`,
        valid,
        valid ? undefined : `invalid package metadata at ${root}`,
      );
    } catch (error) {
      check(checks, "package-graph", `${label}:package-metadata`, false, errorDetail(error));
    }
  }

  const versionSet = new Set(Object.values(versions));
  const coherent = Object.keys(versions).length === 4 && versionSet.size === 1;
  check(
    checks,
    "package-graph",
    "exact-package-version-coherence",
    coherent,
    coherent ? undefined : `observed ${JSON.stringify(versions)}`,
  );
  return versions;
}

async function loadRuntimeModule(
  installation: PiInstallation,
  component: string,
  specifier: PiModuleSpecifier,
  checks: PiRuntimeCheck[],
): Promise<RuntimeModule | null> {
  try {
    const module = await loadPiModule<RuntimeModule>(installation, specifier);
    check(checks, component, "module-load", true);
    return module;
  } catch (error) {
    check(checks, component, "module-load", false, errorDetail(error));
    return null;
  }
}

function checkExports(
  checks: PiRuntimeCheck[],
  component: string,
  module: RuntimeModule | null,
  exports: readonly string[],
): void {
  for (const name of exports) {
    check(
      checks,
      component,
      `export:${name}`,
      module !== null && typeof module[name] === "function",
      module === null ? "module unavailable" : undefined,
    );
  }
}

function checkAgentCore(checks: PiRuntimeCheck[], module: RuntimeModule | null): void {
  const agent = module?.Agent;
  const agentAvailable = typeof agent === "function" || (typeof agent === "object" && agent !== null);
  check(checks, "pi-agent-core", "export:Agent", agentAvailable, agentAvailable ? undefined : "Agent is not a constructor");

  const prototype = typeof agent === "function"
    ? (agent as { prototype?: unknown }).prototype
    : agent;
  for (const method of REQUIRED_AGENT_METHODS) {
    check(
      checks,
      "pi-agent-core",
      `Agent.prototype:${method}`,
      typeof prototype === "object" && prototype !== null && typeof (prototype as Record<string, unknown>)[method] === "function",
      prototype === undefined || prototype === null ? "Agent prototype unavailable" : undefined,
    );
  }
}

function checkExecutable(checks: PiRuntimeCheck[], installation: PiInstallation): void {
  try {
    const output = execFileSync(installation.executable, ["--version"], { encoding: "utf-8", timeout: 10_000 }).trim();
    check(
      checks,
      "pi-executable",
      "version-matches-package",
      output.includes(installation.version),
      output.includes(installation.version) ? undefined : `--version returned ${JSON.stringify(output)}`,
    );
  } catch (error) {
    check(checks, "pi-executable", "version-command", false, errorDetail(error));
  }
}

export async function inspectPiRuntime(): Promise<PiRuntimeReport> {
  const checks: PiRuntimeCheck[] = [];
  const resolved = resolvePiInstallation({ useCache: false });
  if (resolved.state !== "compatible") {
    check(checks, "installation", resolved.state, false, resolved.state === "absent" ? "Pi executable not found" : resolved.reason);
    return { ok: false, packageVersions: {}, checks };
  }

  const installation = resolved.installation;
  check(checks, "installation", "compatible", true);
  checkExecutable(checks, installation);
  const packageVersions = readPackageVersions(installation, checks);

  const ai = await loadRuntimeModule(installation, "pi-ai", { package: "@earendil-works/pi-ai" }, checks);
  const agentCore = await loadRuntimeModule(installation, "pi-agent-core", { package: "@earendil-works/pi-agent-core" }, checks);
  const tui = await loadRuntimeModule(installation, "pi-tui", { package: "@earendil-works/pi-tui" }, checks);
  const codingAgent = await loadRuntimeModule(installation, "pi-coding-agent", { package: "@earendil-works/pi-coding-agent" }, checks);

  checkExports(checks, "pi-ai", ai, ["createProvider", "clampThinkingLevel", "isContextOverflow"]);
  checkAgentCore(checks, agentCore);
  checkExports(checks, "pi-tui", tui, REQUIRED_PI_TUI_EXPORTS);
  checkExports(checks, "pi-coding-agent", codingAgent, REQUIRED_PI_CODING_AGENT_EXPORTS);

  for (const api of API_FAMILIES) {
    const module = await loadRuntimeModule(
      installation,
      `pi-ai/${api}`,
      { package: "@earendil-works/pi-ai", subpath: `api/${api}` },
      checks,
    );
    checkExports(checks, `pi-ai/${api}`, module, ["stream", "streamSimple"]);
  }

  return {
    ok: checks.every((entry) => entry.state === "passed"),
    version: installation.version,
    packageVersions,
    checks,
  };
}
