import { configDir } from "../transport-config.js";
import { existsSync, readFileSync, realpathSync, statSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute, relative, sep, join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import type { ResumeCapability } from "./types.js";

const TAG = "pi-config";

export interface PiExecutorConfig {
  enabled: boolean;
  command: string;
  fixedArgs: readonly string[];
  workspaceAliases: Record<string, { path: string; root?: string; projectTrust?: "always" | "never" }>;
  allowedEnv: readonly string[];
  maxConcurrent: number;
  maxWallClockMs: number;
  abortGraceMs: number;
  projectTrust: "always" | "never";
  sessionStorageRoot: string;
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
      maxConcurrent: raw.maxConcurrent ?? 3,
      maxWallClockMs: raw.maxWallClockMs ?? 30 * 60 * 1000,
      abortGraceMs: raw.abortGraceMs ?? 10_000,
      projectTrust: raw.projectTrust ?? "never",
      // Durable Pi session files live under the abtars state directory by
      // default — the operator may still override with an explicit absolute
      // path. Empty/missing falls back to `~/.abtars/state`.
      sessionStorageRoot: resolveSessionStorageRoot(raw.sessionStorageRoot),
    };

    logInfo(TAG, `Pi executor loaded: ${config.command} (${Object.keys(config.workspaceAliases).length} aliases, max ${config.maxConcurrent} concurrent)`);
    return config;
  } catch (err) {
    logWarn(TAG, `${p}: failed to load — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Resolve the effective durable Pi session storage root. An explicit absolute
 * operator value wins; missing or empty falls back to the abtars `state/`
 * directory (the canonical runtime-state location). The directory is created
 * best-effort so a fresh install never fails with `policy_changed`.
 */
export function resolveSessionStorageRoot(raw: string | undefined): string {
  if (raw && raw.trim()) {
    if (!isAbsolute(raw.trim())) {
      logWarn(TAG, `sessionStorageRoot "${raw}" is not absolute — falling back to the state directory`);
      return join(abtarsHome(), "state");
    }
    return raw.trim();
  }
  const fallback = join(abtarsHome(), "state");
  try {
    mkdirSync(fallback, { recursive: true });
  } catch { /* best effort — the validator reports policy_changed if missing */ }
  return fallback;
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

export function buildTrustArgs(config: PiExecutorConfig, workspaceAlias?: string): string[] {
  const aliasTrust = workspaceAlias ? config.workspaceAliases[workspaceAlias]?.projectTrust : undefined;
  const trust = aliasTrust ?? config.projectTrust;
  return trust === "always" ? ["--approve"] : ["--no-approve"];
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
 *
 * #1635 — `memoryMode: "none"` (interactive coding sessions) structurally
 * disables abmind: the disable flag is set and the three ABMIND correlation
 * variables are omitted. `/pi run` (default "abmind") keeps its byte-identical
 * existing environment.
 */
export function buildChildEnv(
  config: PiExecutorConfig,
  run: { id: string; ownerPrincipalId: string; executionGeneration: number },
  memoryMode: "none" | "abmind" = "abmind",
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
  if (memoryMode === "none") {
    env["ABMIND_HOOKS_DISABLED"] = "true";
    return env;
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
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(canonicalFile);
  } catch {
    // The file can disappear (or become unreadable) between realpath and
    // stat. Treat that race as a missing session rather than letting a raw
    // filesystem exception escape the lifecycle validator.
    return { error: "Session file unreadable" };
  }
  if (!st.isFile()) return { error: "Session path is not a regular file" };
  if (!isPathWithinRoot(canonicalRoot, canonicalFile)) {
    return { error: `Session file "${canonicalFile}" escapes session storage root "${canonicalRoot}"` };
  }
  return { canonicalPath: canonicalFile };
}

// ── #1647: bounded persisted-session proof ─────────────────────────────────

/**
 * Proof that a persisted Pi session target is genuinely resumable. The header
 * read is bounded (at most 64 KiB or through the first newline) and
 * content-free in errors: it never loads or logs the conversation.
 */
export type SessionProof =
  | { ok: true; sessionId: string; canonicalFile: string }
  | { ok: false; capability: Exclude<ResumeCapability, "available">; reason: string };

const SESSION_HEADER_MAX_BYTES = 64 * 1024;

/**
 * #1647 — The single canonical validator for a persisted Pi session target.
 * Used by service, store, executor, interruption, and boot recovery. A saved
 * session is resumable only when all of these hold:
 *
 * - session ID and absolute session-file path are present;
 * - the configured root and file canonicalize successfully;
 * - the target is a regular file inside that root;
 * - a bounded read of the first JSONL record yields `{"type":"session","id":...}`
 *   with the id equal to the expected session ID.
 *
 * Capability vocabulary is truthful: `available` only when every check passes;
 * `never_started` when no identity was established; `session_missing` for
 * absent/unreadable/malformed/mismatched identity; `policy_changed` when the
 * configured root or containment policy no longer permits the target.
 */
export function validatePersistedSession(input: {
  sessionStorageRoot: string;
  expectedSessionId?: string;
  sessionFile?: string;
}): SessionProof {
  if (!input.expectedSessionId && !input.sessionFile) {
    return { ok: false, capability: "never_started", reason: "no Pi session identity established" };
  }
  if (!input.expectedSessionId || !input.sessionFile) {
    return { ok: false, capability: "session_missing", reason: "incomplete persisted session identity" };
  }
  if (!input.sessionStorageRoot) {
    return { ok: false, capability: "policy_changed", reason: "sessionStorageRoot not configured" };
  }
  if (!isAbsolute(input.sessionStorageRoot)) {
    return { ok: false, capability: "policy_changed", reason: "sessionStorageRoot must be absolute" };
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(input.sessionStorageRoot);
  } catch {
    return { ok: false, capability: "policy_changed", reason: "sessionStorageRoot not found" };
  }
  if (!isAbsolute(input.sessionFile)) {
    return { ok: false, capability: "session_missing", reason: "Session file path must be absolute" };
  }
  // Containment on the resolved file: a symlink escaping the root is a policy
  // change, not a missing session.
  let canonicalFile: string;
  try {
    canonicalFile = realpathSync(input.sessionFile);
  } catch {
    return { ok: false, capability: "session_missing", reason: "Session file not found" };
  }
  if (!isPathWithinRoot(canonicalRoot, canonicalFile)) {
    return { ok: false, capability: "policy_changed", reason: "Session file escapes session storage root" };
  }
  // Remaining path checks (regular file) through the shared inner helper.
  const validated = validateSessionFile(input.sessionStorageRoot, input.sessionFile);
  if (validated.error) {
    return { ok: false, capability: "session_missing", reason: validated.error };
  }
  canonicalFile = validated.canonicalPath!;

  const header = readSessionHeader(canonicalFile);
  if (!header.ok) {
    return { ok: false, capability: "session_missing", reason: header.reason };
  }
  if (header.id !== input.expectedSessionId) {
    return { ok: false, capability: "session_missing", reason: "Session header id does not match the persisted session id" };
  }
  return { ok: true, sessionId: header.id, canonicalFile };
}

/** Bounded first-record read: at most 64 KiB or through the first newline. */
function readSessionHeader(canonicalFile: string): { ok: true; id: string } | { ok: false; reason: string } {
  let fd: number;
  try {
    fd = openSync(canonicalFile, "r");
  } catch {
    return { ok: false, reason: "Session file unreadable" };
  }
  try {
    const buf = Buffer.alloc(SESSION_HEADER_MAX_BYTES);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const data = bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf;
    const nl = data.indexOf(0x0a);
    if (nl === -1) {
      return { ok: false, reason: bytesRead >= SESSION_HEADER_MAX_BYTES ? "Session header exceeds the 64 KiB bound" : "Session file has no first record" };
    }
    const line = data.subarray(0, nl).toString("utf-8").trim();
    if (!line) return { ok: false, reason: "Session header record is empty" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: "Session header is not valid JSON" };
    }
    const obj = parsed as { type?: unknown; id?: unknown };
    if (obj === null || typeof obj !== "object" || obj.type !== "session") {
      return { ok: false, reason: "First record is not a session header" };
    }
    if (typeof obj.id !== "string" || obj.id.length === 0) {
      return { ok: false, reason: "Session header has no id" };
    }
    return { ok: true, id: obj.id };
  } catch {
    // A read can fail after open (for example, a concurrent replacement or a
    // permissions race). Resume admission must fail closed with a bounded,
    // content-free proof rather than throwing an OS error.
    return { ok: false, reason: "Session file unreadable" };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}
