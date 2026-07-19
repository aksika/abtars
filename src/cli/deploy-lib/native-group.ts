import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireLock, generateLockToken, releaseLock } from "./shared-native-deps-lock.js";
import { createEmptyManifest, readManifest, upsertRecord, writeManifest } from "./shared-native-deps-manifest.js";
import { resolveSharedNativeRoot, stagingDirPath } from "./shared-native-deps-paths.js";
import type { NativePackageRecord } from "./shared-native-deps-types.js";
import { NATIVE_TARGET_CONTRACT, NATIVE_TARGET_NAMES, nativeTargetProbeId, nativeTargetVersion } from "./native-dep-targets.js";

export interface NativeGroupMutationResult {
  ok: boolean;
  error?: string;
}

export function ensureNativeConsumer(): NativeGroupMutationResult {
  if ((Number(process.version.match(/^v(\d+)/)?.[1]) ?? 0) < NATIVE_TARGET_CONTRACT.nodeMajor) {
    return { ok: false, error: `Native targets require Node ${NATIVE_TARGET_CONTRACT.nodeMajor}; running ${process.version}.` };
  }
  const token = generateLockToken();
  acquireLock("abtars", "native:consumer", token);
  try {
    const manifest = readManifest();
    if (!manifest) return { ok: false, error: "Native dependency manifest is missing or invalid." };
    let updated = manifest;
    for (const name of NATIVE_TARGET_NAMES) {
      const record = updated.packages[name];
      if (!record) return { ok: false, error: `Native package "${name}" is not tracked in the manifest.` };
      if (record.version !== nativeTargetVersion(name) || record.nodeAbi !== process.versions.modules || record.platform !== process.platform || record.arch !== process.arch || record.probe !== nativeTargetProbeId(name) || record.contentHash !== hashContent(join(resolveSharedNativeRoot(), name))) {
        return { ok: false, error: `Native package "${name}" manifest or disk integrity is stale.` };
      }
      const consumers = [...new Set([...record.consumers, "abtars"])].sort() as NativePackageRecord["consumers"];
      updated = { ...updated, packages: { ...updated.packages, [name]: { ...record, consumers } }, generation: updated.generation + 1, updatedAt: new Date().toISOString() };
    }
    writeManifest(updated);
    return { ok: true };
  } finally {
    releaseLock(token);
  }
}

type ClosureEntry = { name: string; version: string; hash: string };
type JournalEntry = { name: string; previous: string | null };

export function hashContent(dir: string): string {
  const hash = createHash("sha256");
  if (!existsSync(dir)) return "";
  const entries = readdirSync(dir, { recursive: true }) as string[];
  for (const entry of entries.sort()) {
    try {
      const content = readFileSync(join(dir, entry));
      hash.update(`${entry}:${content.length}:`);
      hash.update(content);
    } catch {
      // Directory entries and unreadable files do not contribute bytes.
    }
  }
  return hash.digest("hex").slice(0, 16);
}

function probe(nodeModules: string): boolean {
  const code = `
const Database = require(${JSON.stringify(join(nodeModules, "better-sqlite3"))});
const db = new Database(":memory:");
db.exec("select 1");
const sqliteVec = require(${JSON.stringify(join(nodeModules, "sqlite-vec"))});
sqliteVec.load(db);
db.close();
console.log("ok");
`;
  const result = spawnSync(process.execPath, ["-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, NODE_PATH: "" },
  });
  return result.status === 0 && (result.stdout ?? "").trim() === "ok";
}

function cleanup(opId: string, prefix: string): void {
  try { if (existsSync(prefix)) rmSync(prefix, { recursive: true, force: true }); } catch { /* retain diagnostics */ }
  const marker = join(stagingDirPath(), opId);
  try { if (existsSync(marker)) rmSync(marker, { recursive: true, force: true }); } catch { /* retain diagnostics */ }
}

function rollback(journal: JournalEntry[], liveRoot: string): void {
  for (const entry of journal.slice().reverse()) {
    const live = join(liveRoot, entry.name);
    if (existsSync(live)) {
      try { rmSync(live, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (entry.previous && existsSync(entry.previous)) {
      try { renameSync(entry.previous, live); } catch { /* best effort */ }
    }
  }
}

export function mutateNativeGroup(operation: "install" | "update"): NativeGroupMutationResult {
  const nodeMajor = Number(process.version.match(/^v(\d+)/)?.[1]);
  if ((nodeMajor ?? 0) < NATIVE_TARGET_CONTRACT.nodeMajor) {
    return { ok: false, error: `Native targets require Node ${NATIVE_TARGET_CONTRACT.nodeMajor}; running ${process.version}.` };
  }

  const token = generateLockToken();
  acquireLock("abtars", `native:${operation}`, token);
  const opId = `${operation}_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const prefix = join(stagingDirPath(), opId);
  const stagingNm = join(prefix, "node_modules");
  const liveRoot = resolveSharedNativeRoot();
  const journal: JournalEntry[] = [];

  try {
    mkdirSync(stagingNm, { recursive: true });
    const args = ["install", "--prefix", prefix, "--no-audit", "--no-fund"];
    for (const pkg of NATIVE_TARGET_NAMES) args.push(`${pkg}@${nativeTargetVersion(pkg)}`);
    const npm = spawnSync("npm", args, { stdio: "pipe", shell: false, encoding: "utf-8", timeout: 120_000 });
    if (npm.error || npm.status !== 0) {
      cleanup(opId, prefix);
      return { ok: false, error: `npm install failed: ${npm.error?.message ?? npm.stderr?.slice(0, 200) ?? `exit code ${npm.status}`}` };
    }

    const closure: ClosureEntry[] = [];
    for (const name of readdirSync(stagingNm)) {
      const dir = join(stagingNm, name);
      try {
        const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: string };
        if (meta.version) closure.push({ name, version: meta.version, hash: hashContent(dir) });
      } catch { /* skip non-package entries */ }
    }
    for (const name of NATIVE_TARGET_NAMES) {
      if (!closure.some(entry => entry.name === name)) {
        cleanup(opId, prefix);
        return { ok: false, error: `Target package "${name}" not found in npm closure` };
      }
    }

    for (const entry of closure) {
      const live = join(liveRoot, entry.name);
      if (!existsSync(live) || NATIVE_TARGET_NAMES.includes(entry.name as typeof NATIVE_TARGET_NAMES[number])) continue;
      const liveHash = hashContent(live);
      let liveVersion = "unknown";
      try { liveVersion = (JSON.parse(readFileSync(join(live, "package.json"), "utf-8")) as { version?: string }).version ?? "unknown"; } catch { /* report as collision */ }
      if (liveHash !== entry.hash || liveVersion !== entry.version) {
        cleanup(opId, prefix);
        return { ok: false, error: `Collision with unrelated package "${entry.name}"; refusing to overwrite.` };
      }
    }

    if (!probe(stagingNm)) {
      cleanup(opId, prefix);
      return { ok: false, error: "Staged native probes failed" };
    }

    for (const entry of closure) {
      const live = join(liveRoot, entry.name);
      const staged = join(stagingNm, entry.name);
      const previous = existsSync(live) ? `${live}.prev.${opId}` : null;
      if (previous) renameSync(live, previous);
      journal.push({ name: entry.name, previous });
      renameSync(staged, live);
    }

    if (!probe(liveRoot)) {
      rollback(journal, liveRoot);
      cleanup(opId, prefix);
      return { ok: false, error: "Live native probes failed after activation" };
    }

    let manifest = readManifest() ?? createEmptyManifest();
    for (const name of NATIVE_TARGET_NAMES) {
      const entry = closure.find(candidate => candidate.name === name)!;
      const previous = manifest.packages[name];
      const record: NativePackageRecord = {
        version: entry.version,
        nodeAbi: process.versions.modules,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        contentHash: entry.hash,
        installedAt: new Date().toISOString(),
        installedBy: "abtars",
        consumers: [...new Set([...(previous?.consumers ?? []), "abtars"])].sort() as NativePackageRecord["consumers"],
        probe: nativeTargetProbeId(name),
      };
      manifest = upsertRecord(manifest, name, record);
    }
    writeManifest(manifest);
    for (const entry of journal) {
      if (entry.previous && existsSync(entry.previous)) {
        try { rmSync(entry.previous, { recursive: true, force: true }); } catch { /* retain a recoverable previous copy */ }
      }
    }
    cleanup(opId, prefix);
    return { ok: true };
  } catch (err) {
    if (journal.length > 0) rollback(journal, liveRoot);
    cleanup(opId, prefix);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseLock(token);
  }
}
