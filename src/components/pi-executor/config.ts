import { configDir } from "../transport-config.js";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { logInfo, logWarn, logDebug } from "../logger.js";

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
    logDebug(TAG, "No pi-executor.json found — Pi executor disabled");
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<PiExecutorConfig>;
    if (raw.enabled === false) { logDebug(TAG, "Pi executor disabled in config"); return null; }
    if (!raw.command) { logWarn(TAG, `${p}: enabled but missing "command" — Pi executor will not start`); return null; }
    if (!raw.workspaceAliases || Object.keys(raw.workspaceAliases).length === 0) {
      logWarn(TAG, `${p}: enabled but no workspace aliases configured — add at least one alias to enable delegation`);
      return null;
    }

    const fixedArgs = (raw.fixedArgs ?? []) as readonly string[];
    const faErrors = validateFixedArgs(fixedArgs);
    if (faErrors.length > 0) {
      for (const err of faErrors) logWarn(TAG, err);
      return null;
    }

    const config: PiExecutorConfig = {
      enabled: true,
      command: raw.command,
      fixedArgs,
      workspaceAliases: raw.workspaceAliases,
      allowedEnv: raw.allowedEnv ?? [],
      maxConcurrent: raw.maxConcurrent ?? 1,
      maxWallClockMs: raw.maxWallClockMs ?? 30 * 60 * 1000,
      abortGraceMs: raw.abortGraceMs ?? 10_000,
      projectTrust: raw.projectTrust ?? "never",
      sessionStorageRoot: raw.sessionStorageRoot ?? "",
      abmindPlugin: raw.abmindPlugin ?? "",
    };

    logInfo(TAG, `Pi executor loaded: ${config.command} (${Object.keys(config.workspaceAliases).length} aliases, max ${config.maxConcurrent} concurrent)`);
    return config;
  } catch (err) {
    logWarn(TAG, `${p}: failed to load — ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * Validate fixed args against the published Pi CLI flags. Returns an array of
 * error messages for each rejected or conflicting argument. The caller should
 * treat any non-empty result as a boot-time configuration error.
 *
 * Rejects duplicates/conflicts for mode, trust, extension, provider/model, and
 * session ownership arguments — these are owned by the executor and must not
 * be overridable via fixedArgs.
 */
export function validateFixedArgs(fixedArgs: readonly string[]): string[] {
  const errors: string[] = [];
  const FORBIDDEN_FLAGS = new Set([
    "--mode", "--approve", "--no-approve", "--extension",
    "--provider", "--model", "--session-storage-root",
    "--rpc-version",
  ]);
  for (const arg of fixedArgs) {
    if (FORBIDDEN_FLAGS.has(arg)) {
      errors.push(`Fixed argument "${arg}" is owned by the executor and must not be set in fixedArgs`);
    }
  }
  return errors;
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
    const val = process.env[name];
    if (val) env[name] = val;
  }
  for (const name of config.allowedEnv) {
    if (DANGEROUS_NODE_VARS.includes(name)) continue;
    const val = process.env[name];
    if (val) env[name] = val;
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
