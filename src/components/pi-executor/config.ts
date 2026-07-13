import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { logInfo, logWarn } from "../logger.js";
import { configDir } from "../transport-config.js";

const TAG = "pi-config";

export interface PiExecutorConfig {
  enabled: boolean;
  command: string;
  fixedArgs: readonly string[];
  workspaceAliases: Record<string, { path: string; root?: string }>;
  allowedEnv: readonly string[];
  maxConcurrent: number;
  maxWallClockMs: number;
  abortGraceMs: number;
  projectTrust: "always" | "never";
  sessionStorageRoot: string;
  abmindPlugin: string;
  supportedRpcVersion: string;
  defaultModel?: { provider: string; modelId: string; thinking?: string };
}

// ── #1394: Component-aware path containment ─────────────────────────────────

export interface PathOps {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

/**
 * Pure containment check. Both paths must be already-canonical absolute paths.
 * Accepts when candidate equals root or is a proper descendant by path
 * components (not by string prefix).
 */
export function isPathWithinRoot(
  canonicalRoot: string,
  canonicalCandidate: string,
  pathOps: PathOps = { relative, isAbsolute, sep },
): boolean {
  const rel = pathOps.relative(canonicalRoot, canonicalCandidate);
  if (rel === "") return true;          // exact equality
  if (pathOps.isAbsolute(rel)) return false;  // different drives/roots
  if (rel === "..") return false;
  if (rel.startsWith(`..${pathOps.sep}`)) return false;
  return true;
}

/** #1394: Validate all workspace aliases at boot. Returns error map keyed by alias. */
export function validatePiWorkspaceAliases(config: PiExecutorConfig): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const alias of Object.keys(config.workspaceAliases)) {
    const r = resolveAndValidateWorkspace(alias, config);
    if (r.error) errors[alias] = r.error;
  }
  return errors;
}

export function loadPiConfig(): PiExecutorConfig | null {
  const p = resolve(configDir(), "pi-executor.json");
  if (!existsSync(p)) {
    logInfo(TAG, "No pi-executor.json found — Pi executor disabled");
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<PiExecutorConfig>;
    if (!raw.enabled) { logInfo(TAG, "Pi executor disabled in config"); return null; }
    if (!raw.command) return null;
    if (!raw.workspaceAliases || Object.keys(raw.workspaceAliases).length === 0) return null;

    const config: PiExecutorConfig = {
      enabled: true,
      command: raw.command,
      fixedArgs: raw.fixedArgs ?? [],
      workspaceAliases: raw.workspaceAliases,
      allowedEnv: raw.allowedEnv ?? [],
      maxConcurrent: raw.maxConcurrent ?? 1,
      maxWallClockMs: raw.maxWallClockMs ?? 30 * 60 * 1000,
      abortGraceMs: raw.abortGraceMs ?? 10_000,
      projectTrust: raw.projectTrust ?? "never",
      sessionStorageRoot: raw.sessionStorageRoot ?? "",
      abmindPlugin: raw.abmindPlugin ?? "",
      supportedRpcVersion: raw.supportedRpcVersion ?? "0.1",
      defaultModel: raw.defaultModel,
    };

    logInfo(TAG, `Pi executor loaded: ${config.command} (${Object.keys(config.workspaceAliases).length} aliases, max ${config.maxConcurrent} concurrent)`);
    return config;
  } catch (err) {
    logWarn(TAG, `Failed to load pi-executor.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function resolveAndValidateWorkspace(alias: string, config: PiExecutorConfig): { canonicalPath: string; error?: string } {
  const mapping = config.workspaceAliases[alias];
  if (!mapping) return { canonicalPath: "", error: `Unknown workspace alias "${alias}"` };
  if (typeof alias !== "string" || alias.length > 128) return { canonicalPath: "", error: `Invalid alias` };
  if (!isAbsolute(mapping.path)) return { canonicalPath: "", error: `Path must be absolute` };
  if (!existsSync(mapping.path)) return { canonicalPath: "", error: `Path "${mapping.path}" does not exist` };
  try {
    const canonical = realpathSync(mapping.path);
    const st = statSync(canonical);
    if (!st.isDirectory()) return { canonicalPath: "", error: `Not a directory` };
    if (mapping.root) {
      if (!isAbsolute(mapping.root)) return { canonicalPath: "", error: `Root must be absolute` };
      if (!existsSync(mapping.root)) return { canonicalPath: "", error: `Root "${mapping.root}" not found` };
      const canonicalRoot = realpathSync(mapping.root);
      const rootSt = statSync(canonicalRoot);
      if (!rootSt.isDirectory()) return { canonicalPath: "", error: `Root is not a directory` };
      if (!isPathWithinRoot(canonicalRoot, canonical)) return { canonicalPath: "", error: `Escapes root "${canonicalRoot}"` };
    }
    return { canonicalPath: canonical };
  } catch (err) {
    return { canonicalPath: "", error: `Resolution failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function buildTrustArgs(config: PiExecutorConfig): string[] {
  return config.projectTrust === "always" ? ["--approve"] : ["--no-approve"];
}

const FIXED_ENV_BASELINE = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"];

const DANGEROUS_NODE_VARS = ["NODE_OPTIONS", "NODE_PATH", "NODE_DEBUG", "NODE_EXTRA_CA_CERTS"];

/**
 * #1405 — Build the child process environment from fixed baseline + explicit
 * allowlist + ABMIND correlation variables. Deny-by-default: no process.env
 * values cross unless explicitly allowlisted or in the fixed baseline.
 */
export function buildChildEnv(
  config: PiExecutorConfig,
  run: { id: string; ownerPrincipalId: string; executionGeneration: number },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of FIXED_ENV_BASELINE) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  for (const name of config.allowedEnv) {
    if (DANGEROUS_NODE_VARS.includes(name)) continue;
    if (process.env[name]) env[name] = process.env[name]!;
  }
  env["ABMIND_USER_ID"] = run.ownerPrincipalId;
  env["ABMIND_PARENT_EXECUTION_ID"] = `pi-run-${run.id}-gen-${run.executionGeneration}`;
  env["ABMIND_AUTOMATIC_WRITE_OWNER"] = "abmind-pi-plugin";
  return env;
}

/**
 * #1405 — Validate and canonicalize a Pi session file path.
 * Requires a configured absolute session storage root. Returns the canonical
 * absolute path or an error string.
 */
export function validateSessionFile(
  sessionStorageRoot: string,
  filePath: string,
): { canonicalPath?: string; error?: string } {
  if (!sessionStorageRoot) return { error: "sessionStorageRoot not configured" };
  if (!isAbsolute(sessionStorageRoot)) return { error: "sessionStorageRoot must be absolute" };
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(sessionStorageRoot);
  } catch {
    return { error: `sessionStorageRoot "${sessionStorageRoot}" not found` };
  }
  if (!isAbsolute(filePath)) return { error: "Session file path must be absolute" };
  let canonicalFile: string;
  try {
    canonicalFile = realpathSync(filePath);
  } catch {
    return { error: `Session file "${filePath}" not found` };
  }
  const st = statSync(canonicalFile);
  if (!st.isFile()) return { error: "Session path is not a regular file" };
  if (!isPathWithinRoot(canonicalRoot, canonicalFile)) {
    return { error: `Session file "${canonicalFile}" escapes session storage root "${canonicalRoot}"` };
  }
  return { canonicalPath: canonicalFile };
}

export function buildPluginArgs(config: PiExecutorConfig): string[] {
  if (!config.abmindPlugin) return [];
  return ["--extension", config.abmindPlugin];
}
