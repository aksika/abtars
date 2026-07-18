import { existsSync, chmodSync, mkdirSync, statSync, readFileSync, readdirSync, unlinkSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { abtarsHome } from "../../paths.js";
import type { FixResult, DoctorOutputV2 } from "./doctor-types.js";

const STALE_MS = 5 * 60 * 1000;

function isStaleLockContent(content: Record<string, unknown>): boolean {
  const pid = typeof content.pid === "number" ? content.pid : 0;
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) return true;
  const startedAt = typeof content.startedAt === "string" ? Date.parse(content.startedAt) : NaN;
  const age = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
  return age > STALE_MS;
}

export interface DoctorFixDefinition {
  id: string;
  probe: string;
  bootSafe: boolean;
  applicable(before: DoctorOutputV2): boolean;
  revalidate(): { ok: true } | { ok: false; reason: string };
  apply(): void;
}

const home = abtarsHome();
const _require = createRequire(import.meta.url);

const KNOWN_DIRS = ["config", "secret", "auth", "hooks", "logs", "workspace", "overflow", "received", "kanban", "state", "prompts"] as const;
const SENSITIVE_DIRS = ["config", "secret", "auth", "hooks"] as const;
const SECRET_FILE_MODE = 0o600;
const SENSITIVE_DIR_MODE = 0o700;

function isSymlink(target: string): boolean {
  try { return lstatSync(target).isSymbolicLink(); } catch { return false; }
}

function underHome(target: string): boolean {
  const rel = relative(home, target);
  return !rel.startsWith("..") && rel !== "";
}

function isDir(target: string): boolean {
  try { return statSync(target).isDirectory(); } catch { return false; }
}

function isFile(target: string): boolean {
  try { return statSync(target).isFile(); } catch { return false; }
}

const definitions: DoctorFixDefinition[] = [
  {
    id: "chmod-sensitive-dirs",
    probe: "security",
    bootSafe: true,
    applicable: () => true,
    revalidate: () => ({ ok: true }),
    apply: () => {
      for (const dir of SENSITIVE_DIRS) {
        const p = join(home, dir);
        if (existsSync(p) && isDir(p) && (statSync(p).mode & 0o777) !== SENSITIVE_DIR_MODE) {
          chmodSync(p, SENSITIVE_DIR_MODE);
        }
      }
    },
  },
  {
    id: "chmod-secret-files",
    probe: "security",
    bootSafe: true,
    applicable: () => true,
    revalidate: () => ({ ok: true }),
    apply: () => {
      const secretDir = join(home, "secret");
      if (existsSync(secretDir) && isDir(secretDir)) {
        for (const f of readdirSync(secretDir)) {
          const fp = join(secretDir, f);
          if (isFile(fp) && (statSync(fp).mode & 0o777) !== SECRET_FILE_MODE) {
            chmodSync(fp, SECRET_FILE_MODE);
          }
        }
      }
    },
  },
  {
    id: "chmod-config-files",
    probe: "security",
    bootSafe: true,
    applicable: () => true,
    revalidate: () => ({ ok: true }),
    apply: () => {
      const configDir = join(home, "config");
      if (existsSync(configDir) && isDir(configDir)) {
        for (const f of readdirSync(configDir)) {
          const fp = join(configDir, f);
          if (isFile(fp) && (statSync(fp).mode & 0o777) !== SECRET_FILE_MODE) {
            chmodSync(fp, SECRET_FILE_MODE);
          }
        }
      }
    },
  },
  {
    id: "create-missing-dirs",
    probe: "body",
    bootSafe: true,
    applicable: () => true,
    revalidate: () => ({ ok: true }),
    apply: () => {
      for (const dir of KNOWN_DIRS) {
        const p = join(home, dir);
        if (!existsSync(p)) mkdirSync(p, { recursive: true });
      }
    },
  },
  {
    id: "remove-stale-deploy-lock",
    probe: "watchdog",
    bootSafe: false,
    applicable: (before: DoctorOutputV2) => {
      const bodyProbes = before.layers.body ?? [];
      return bodyProbes.some(p => p.name === "watchdog" && p.status === "failed");
    },
    revalidate: (): { ok: true } | { ok: false; reason: string } => {
      const deployLock = join(home, "deploy.lock");
      if (!existsSync(deployLock)) return { ok: false, reason: "does not exist" };
      if (isSymlink(deployLock)) return { ok: false, reason: "is a symlink" };
      if (!underHome(deployLock)) return { ok: false, reason: "escapes home" };
      let content: Record<string, unknown>;
      try { content = JSON.parse(readFileSync(deployLock, "utf-8")); } catch { return { ok: false, reason: "unparseable" }; }
      if (!isStaleLockContent(content)) return { ok: false, reason: "lock held by live process" };
      return { ok: true };
    },
    apply: () => {
      unlinkSync(join(home, "deploy.lock"));
    },
  },
  {
    id: "fail-abandoned-kanban-cards",
    probe: "kanban",
    bootSafe: false,
    applicable: (before: DoctorOutputV2) => {
      const brainProbes = before.layers.brain ?? [];
      return brainProbes.some(p => p.name === "kanban" && p.status === "failed");
    },
    revalidate: (): { ok: true } | { ok: false; reason: string } => {
      const dbPath = join(home, "kanban", "kanban.db");
      if (!existsSync(dbPath)) return { ok: false, reason: "no kanban.db" };
      const sharedNm = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
      if (!existsSync(sharedNm)) return { ok: false, reason: "better-sqlite3 not installed" };
      return { ok: true };
    },
    apply: () => {
      const dbPath = join(home, "kanban", "kanban.db");
      if (!existsSync(dbPath)) return;
      const cutoff = new Date(Date.now() - 86_400_000).toISOString();
      try {
        const Database = _require(join(homedir(), ".local", "lib", "node_modules", "better-sqlite3"));
        const db = new Database(dbPath);
        db.prepare(
          "UPDATE kanban_board SET status = 'failed', error = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE status = 'running' AND updated_at < ?"
        ).run("Abandoned — auto-failed by doctor fix", cutoff);
        db.close();
      } catch { /* best-effort */ }
    },
  },
];

export function getDefinitions(): DoctorFixDefinition[] {
  return definitions;
}

export function getBootSafeDefinitions(): DoctorFixDefinition[] {
  return definitions.filter(d => d.bootSafe);
}

export function runDoctorFixes(before: DoctorOutputV2): FixResult[] {
  const results: FixResult[] = [];
  for (const def of definitions) {
    if (!def.applicable(before)) continue;
    const reval = def.revalidate();
    if (!reval.ok) {
      results.push({ id: def.id, probe: def.probe, action: `${def.id}`, outcome: "refused", reason: reval.reason });
      continue;
    }
    try {
      def.apply();
      results.push({ id: def.id, probe: def.probe, action: `${def.id}`, outcome: "applied" });
    } catch (err) {
      results.push({ id: def.id, probe: def.probe, action: `${def.id}`, outcome: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

export function runBootRepairs(): FixResult[] {
  const results: FixResult[] = [];
  for (const def of definitions) {
    if (!def.bootSafe) continue;
    const reval = def.revalidate();
    if (!reval.ok) continue;
    try {
      def.apply();
      results.push({ id: def.id, probe: def.probe, action: `${def.id}`, outcome: "applied" });
    } catch {
      results.push({ id: def.id, probe: def.probe, outcome: "failed", action: `${def.id}` });
    }
  }
  return results;
}
