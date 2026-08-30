/**
 * transport-config/writer.ts — atomic persistence of transport.json:
 * candidate writes, demotion mutation/persistence, restore/reset swaps.
 * All filesystem write/rename/unlink choreography lives here.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getEnv } from "../env-schema.js";
import { logInfo, logWarn } from "../logger.js";
import type {
  AssignmentIssue,
  ExecutionRoute,
  TransportConfig,
  TransportWriteResult,
} from "./types.js";
import { configDir, loadTransport, cacheTransportAfterWrite, clearTransportCache } from "./loader.js";
import { validateTransportConfig, serializeTransportConfig, validateTransportAssignments, routeAssignments } from "./validator.js";

const TAG = "transport-config";

export function writeTransportConfig(candidate: TransportConfig, reason: string): TransportWriteResult {
  if (typeof reason !== "string" || !reason.trim()) {
    return { ok: false, issues: [{ location: "reason", model: "", provider: "", reason: "A non-empty mutation reason is required" }] };
  }
  // Validate the complete candidate — use a detached deep copy so input mutation
  // doesn't leak into validation, and failed writes leave the cache unchanged.
  const candidateCopy = JSON.parse(JSON.stringify(candidate)) as TransportConfig;
  const vr = validateTransportConfig(candidateCopy);
  if (!vr.ok) {
    const issues: AssignmentIssue[] = vr.issues.map(i => ({ location: i.path, model: "", provider: "", reason: i.message }));
    for (const iss of issues) logWarn(TAG, `Refusing to write — ${iss.reason}`);
    return { ok: false, issues };
  }
  // #1415: reject known-incompatible model/provider pairs before persisting
  const compatIssues = validateTransportAssignments(vr.config);
  if (compatIssues.length > 0) {
    for (const iss of compatIssues) logWarn(TAG, `Refusing to write — ${iss.reason}`);
    return { ok: false, issues: compatIssues };
  }
  // Guard: reject empty model strings in the active route block
  const activeRa = routeAssignments(vr.config);
  if (activeRa) {
    for (const [role, agent] of Object.entries(activeRa.agents)) {
      if (!agent.model?.trim()) {
        logWarn(TAG, `Refusing to write transport.json — agent "${role}" has empty model`);
        return { ok: false, issues: [{ location: role, model: agent.model ?? "", provider: agent.provider, reason: `empty model string` }] };
      }
    }
  }

  const p = join(configDir(), getEnv().transportConfig);
  const oldPath = p.replace(".json", ".old.json");

  // Read current primary bytes for backup (before any mutation)
  let currentBytes: string | null = null;
  let currentCanonical: string | null = null;
  try { currentBytes = readFileSync(p, "utf-8"); } catch { /* no existing primary */ }

  // #1354: unsafe existing content (raw credential fields) must never enter
  // a backup or a temp file. A safe candidate may replace it; we emit a
  // value-free warning and skip the backup instead of copying unsafe bytes.
  let currentSafe = currentBytes === null;
  if (currentBytes !== null) {
    try {
      const currentParsed = JSON.parse(currentBytes) as Record<string, unknown>;
      const currentVr = validateTransportConfig(currentParsed);
      currentSafe = currentVr.ok;
      if (currentVr.ok) {
        try { currentCanonical = serializeTransportConfig(currentVr.config); }
        catch { currentSafe = false; }
      }
      if (!currentVr.ok && currentVr.issues.some(i => i.code === "plaintext_secret_field")) {
        logWarn(TAG, `Existing transport.json contains raw credential fields — replacing it without backing up unsafe content`);
      }
    } catch {
      currentSafe = false;
    }
  }

  // Serialize candidate deterministically through the validated serializer
  // (use validated config, not raw input).
  const content = serializeTransportConfig(vr.config);

  const tmp = p + ".tmp." + process.pid;
  const oldTmp = oldPath + ".tmp." + process.pid;
  const rollbackPrimaryTmp = p + ".rollback." + process.pid;
  const rollbackOldTmp = oldPath + ".rollback." + process.pid;
  let primaryCommitted = false;
  let backupAttempted = false;
  const oldBackupExists = existsSync(oldPath);
  // #1354: never snapshot unsafe bytes (legacy backups may contain raw
  // credential fields — they must never re-enter temp/rollback files).
  let oldBackupSafe = false;
  let oldBackupCanonical: string | null = null;
  if (oldBackupExists) {
    try {
      const oldVr = validateTransportConfig(JSON.parse(readFileSync(oldPath, "utf-8")) as Record<string, unknown>);
      oldBackupSafe = oldVr.ok;
      if (oldVr.ok) {
        try { oldBackupCanonical = serializeTransportConfig(oldVr.config); }
        catch { oldBackupSafe = false; }
      }
    } catch { oldBackupSafe = false; }
  }
  try {
    if (oldBackupExists && oldBackupSafe) {
      writeFileSync(rollbackOldTmp, oldBackupCanonical!, "utf-8");
    }
    writeFileSync(tmp, content, "utf-8");

    if (currentBytes !== null && currentSafe) {
      writeFileSync(oldTmp, currentCanonical!, "utf-8");
      writeFileSync(rollbackPrimaryTmp, currentCanonical!, "utf-8");
    }

    renameSync(tmp, p);
    primaryCommitted = true;

    if (currentBytes !== null && currentSafe) {
      backupAttempted = true;
      renameSync(oldTmp, oldPath);
    }

    cacheTransportAfterWrite(vr.config);
    try { unlinkSync(rollbackPrimaryTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    logInfo(TAG, `transport.json updated — ${reason}`);
    return { ok: true };
  } catch (err) {
    // If backup commit was attempted, restore the previous backup (or its
    // absence). If primary commit succeeded, restore the previous primary too.
    if (backupAttempted) {
      try {
        if (oldBackupExists) renameSync(rollbackOldTmp, oldPath);
        else if (existsSync(oldPath)) unlinkSync(oldPath);
      } catch { /* best effort */ }
    }
    if (primaryCommitted && currentBytes !== null) {
      try { renameSync(rollbackPrimaryTmp, p); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    try { unlinkSync(oldTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackPrimaryTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    logWarn(TAG, `Failed to write transport.json: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, issues: [{ location: "write", model: "", provider: "", reason: `Write failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

/** Remove demoted models from config. Called on user-initiated model switch.
 *  Models the user just chose are resurrected (demotion cleared). All other demoted entries are deleted.
 *  Defaults to the active route only — never bleeds into inactive routes. Use explicitRoute list for bulk cleanup. */
export function cleanDemotedModels(tc: TransportConfig, chosenModel?: string, explicitRoute?: ExecutionRoute): void {
  const routesToClean = explicitRoute ? [explicitRoute] : ([tc.activeRoute] as ExecutionRoute[]);
  for (const r of routesToClean) {
    const ra = tc.routes[r];
    if (!ra) continue;
    for (const agent of Object.values(ra.agents)) {
      if ((agent as any).demoted) {
        if (agent.model === chosenModel) { delete (agent as any).demoted; delete (agent as any).demotedReason; delete (agent as any).demotedModel; }
      }
    }
    for (const fb of ra.fallbacks ?? []) {
      if ((fb as any).demoted && fb.model === chosenModel) { delete (fb as any).demoted; delete (fb as any).demotedReason; delete (fb as any).demotedModel; }
    }
  }
}

/** Mark a model as demoted in transport.json. Skipped by candidate loading. Never demotes the last available model for a role. */
export function demoteModel(model: string, reason: "auth" | "timeout"): void {
  const tc = loadTransport();
  if (!tc) return;
  // Work on a detached candidate — never mutate the cached object
  const candidate = JSON.parse(JSON.stringify(tc)) as TransportConfig;
  // Guard: don't demote if it's the last non-demoted model for any role
  const activeRa = routeAssignments(candidate);
  if (activeRa) {
    for (const agent of Object.values(activeRa.agents)) {
      const all = [agent, ...(activeRa.fallbacks ?? [])];
      const healthy = all.filter((m: any) => !m.demoted);
      if (healthy.length <= 1 && healthy.some((m: any) => m.model === model)) return;
    }
  }
  let found = false;
  if (activeRa) {
    for (const agent of Object.values(activeRa.agents)) {
      if (agent.model === model) { (agent as any).demoted = new Date().toISOString(); (agent as any).demotedReason = reason; (agent as any).demotedModel = model; found = true; }
    }
    for (const fb of activeRa.fallbacks ?? []) {
      if (fb.model === model) { (fb as any).demoted = new Date().toISOString(); (fb as any).demotedReason = reason; (fb as any).demotedModel = model; found = true; }
    }
  }
  if (found) writeTransportConfig(candidate, `auto-demote ${model} (${reason})`);
}

/** Swap transport.json ↔ transport.json.old (undo last write). Rollback-safe. */
export function restorePrevious(): { ok: boolean; error?: string } {
  const dir = configDir();
  const activePath = join(dir, getEnv().transportConfig);
  const oldPath = activePath.replace(".json", ".old.json");
  const tmp = activePath + ".tmp." + process.pid;
  const oldTmp = oldPath + ".tmp." + process.pid;
  const rollbackActiveTmp = activePath + ".rollback." + process.pid;
  const rollbackOldTmp = oldPath + ".rollback." + process.pid;
  let activeCommitted = false;
  let oldAttempted = false;
  if (!existsSync(oldPath)) return { ok: false, error: "Nothing to restore — no previous config saved." };
  try {
    const current = readFileSync(activePath, "utf-8");
    const old = readFileSync(oldPath, "utf-8");
    // Validate the backup before swapping
    const oldParsed = JSON.parse(old) as Record<string, unknown>;
    const vr = validateTransportConfig(oldParsed);
    if (!vr.ok) {
      return { ok: false, error: `Backup config is invalid — cannot restore. Issues: ${vr.issues.map(i => i.message).join("; ")}` };
    }
    // Re-serialize the parsed, validated object. Copying raw backup bytes
    // would allow duplicate JSON keys to smuggle a rejected credential into
    // the restored primary even though JSON.parse saw only the last key.
    const oldCanonical = serializeTransportConfig(vr.config);
    // #1354: the previous active config becomes the new backup after the
    // swap — if it contains raw credential fields it must never be written
    // to the backup. In that case the old backup is dropped instead.
    let currentSafe = true;
    let currentCanonical: string | null = null;
    try {
      const currentVr = validateTransportConfig(JSON.parse(current) as Record<string, unknown>);
      currentSafe = currentVr.ok;
      if (currentVr.ok) {
        try { currentCanonical = serializeTransportConfig(currentVr.config); }
        catch { currentSafe = false; }
      }
    } catch { currentSafe = false; }
    // Snapshot both files before swapping so a failed second rename can roll
    // the first rename back as well.
    writeFileSync(tmp, oldCanonical, "utf-8");
    if (currentSafe) {
      writeFileSync(oldTmp, currentCanonical!, "utf-8");
      writeFileSync(rollbackActiveTmp, currentCanonical!, "utf-8");
    }
    writeFileSync(rollbackOldTmp, oldCanonical, "utf-8");
    renameSync(tmp, activePath);
    activeCommitted = true;
    if (currentSafe) {
      oldAttempted = true;
      renameSync(oldTmp, oldPath);
    } else {
      // Unsafe previous active — never keep it as a backup.
      unlinkSync(oldPath);
    }
    try { unlinkSync(rollbackActiveTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    clearTransportCache();
    logInfo(TAG, "transport.json swapped with .old (restore)");
    return { ok: true };
  } catch (err) {
    // Restore whichever side may have been committed before the failure.
    try { if (oldAttempted) renameSync(rollbackOldTmp, oldPath); } catch { /* best effort */ }
    try { if (activeCommitted) renameSync(rollbackActiveTmp, activePath); } catch { /* best effort */ }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    try { unlinkSync(oldTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackActiveTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    return { ok: false, error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Copy transport.default.json → transport.json atomically, backup current first. */
export function resetToDefaults(): boolean {
  const dir = configDir();
  const defaultPath = join(dir, "transport.default.json");
  const activePath = join(dir, getEnv().transportConfig);
  const oldPath = activePath.replace(".json", ".old.json");
  const tmp = activePath + ".tmp." + process.pid;
  const oldTmp = oldPath + ".tmp." + process.pid;
  const rollbackActiveTmp = activePath + ".rollback." + process.pid;
  const rollbackOldTmp = oldPath + ".rollback." + process.pid;
  let currentBytes: string | null = null;
  let oldBackupExists = false;
  let primaryCommitted = false;
  let backupAttempted = false;
  try {
    // Validate defaults before swapping
    const defaultRaw = readFileSync(defaultPath, "utf-8");
    const defaultParsed = JSON.parse(defaultRaw) as Record<string, unknown>;
    const vr = validateTransportConfig(defaultParsed);
    if (!vr.ok) {
      logWarn(TAG, `transport.default.json is invalid — keeping current config. Issues: ${vr.issues.map(i => i.message).join("; ")}`);
      return false;
    }
    // #1354: snapshot only SAFE content. An unsafe current primary or legacy
    // backup (raw credential fields) must never enter a backup or temp file.
    oldBackupExists = existsSync(oldPath);
    let oldBackupSafe = false;
    let oldBackupCanonical: string | null = null;
    if (oldBackupExists) {
      try {
        const oldVr = validateTransportConfig(JSON.parse(readFileSync(oldPath, "utf-8")) as Record<string, unknown>);
        oldBackupSafe = oldVr.ok;
        if (oldVr.ok) {
          try { oldBackupCanonical = serializeTransportConfig(oldVr.config); }
          catch { oldBackupSafe = false; }
        }
      } catch { oldBackupSafe = false; }
    }
    let currentSafe = true;
    let currentCanonical: string | null = null;
    if (existsSync(activePath)) {
      currentBytes = readFileSync(activePath, "utf-8");
      try {
        const currentVr = validateTransportConfig(JSON.parse(currentBytes) as Record<string, unknown>);
        currentSafe = currentVr.ok;
        if (currentVr.ok) {
          try { currentCanonical = serializeTransportConfig(currentVr.config); }
          catch { currentSafe = false; }
        }
        if (!currentSafe) {
          logWarn(TAG, `Existing transport.json contains raw credential fields — resetting without backing it up`);
        }
      } catch { currentSafe = false; }
    }
    if (oldBackupExists && oldBackupSafe) writeFileSync(rollbackOldTmp, oldBackupCanonical!, "utf-8");
    if (currentBytes !== null && currentSafe) {
      writeFileSync(oldTmp, currentCanonical!, "utf-8");
      writeFileSync(rollbackActiveTmp, currentCanonical!, "utf-8");
    }
    writeFileSync(tmp, serializeTransportConfig(vr.config), "utf-8");
    renameSync(tmp, activePath);
    primaryCommitted = true;
    if (currentBytes !== null && currentSafe) {
      backupAttempted = true;
      renameSync(oldTmp, oldPath);
    }
    try { unlinkSync(rollbackActiveTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    clearTransportCache();
    logInfo(TAG, "transport.json reset to defaults (old saved as .old.json)");
    return true;
  } catch (err) {
    if (backupAttempted) {
      try {
        if (oldBackupExists) renameSync(rollbackOldTmp, oldPath);
        else if (existsSync(oldPath)) unlinkSync(oldPath);
      } catch { /* best effort */ }
    }
    if (primaryCommitted && currentBytes !== null) {
      try { renameSync(rollbackActiveTmp, activePath); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    try { unlinkSync(oldTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackActiveTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    logWarn(TAG, `No transport.default.json — keeping current config: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
