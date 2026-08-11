/**
 * env-secret-migration.ts — #1354: testable dotenv → secret/ credential
 * migration, extracted from boot/env.ts. Pure decision + rewrite planning;
 * filesystem side effects go through the injected SecretIO so the full
 * conflict matrix is unit-testable without a real store.
 *
 * Scope: `.env` / `.env.skills` credential-shaped assignments (ending in
 * _KEY/_TOKEN/_SECRET/_PASSWORD/_API_ID) are migrated into the authoritative
 * secret store. Secrets are committed BEFORE any source rewrite. Anything
 * that cannot complete safely leaves source files unchanged and the
 * file-loaded value unavailable for that boot.
 */

export interface InputFile {
  path: string;
  content: string;
}

export type SecretIO = {
  /** Compare an existing stored secret against a plaintext candidate. */
  compare(name: string, value: string): "missing" | "equal" | "different" | "unreadable";
  /** Durably commit a secret. Throws on any failure (value-free). */
  commit(name: string, value: string): void;
};

export type MigrationOutcome =
  /** Authoritative secret written from plaintext. */
  | "migrated"
  /** Plaintext equals existing stored secret. */
  | "kept-existing"
  /** Plaintext differs from existing stored secret — existing wins, redacted warning. */
  | "conflict-kept-existing"
  /** Conflicting plaintext values and no authoritative secret — rotation required. */
  | "rejected-conflict"
  /** Store unsafe or commit failed — nothing derived from plaintext. */
  | "rejected-unsafe";

export interface MigrationDecision {
  key: string;
  outcome: MigrationOutcome;
  /** basenames of the source files the key appeared in (for redacted logging). */
  sources: string[];
  /** value-free reason for rejected outcomes. */
  reason?: string;
}

export interface MigrationResult {
  /** One decision per credential-shaped key found in any input file. */
  decisions: MigrationDecision[];
  /** Rewritten file contents — only for files whose plaintext was removed. */
  files: Array<{ path: string; content: string }>;
  /** Keys removed per file (for rewrite-failure bookkeeping). */
  removedByFile: Array<{ path: string; keys: string[] }>;
  /** Keys whose file-loaded process.env value must be removed this boot. */
  envKeysToUnset: string[];
  /** Secrets durably committed during this run. */
  committedSecrets: string[];
}

/** Parsed dotenv line — raw text preserved for lossless rewrites. */
export type ParsedLine =
  | { key: string; value: string; raw: string; kind: "assignment" }
  | { raw: string; kind: "other" };

/** Env-var name shape + credential suffix test (shared with secrets.ts). */
export function isSecretEnvName(name: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return false;
  return ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_API_ID"].some(s => name.endsWith(s));
}

/**
 * Parse a dotenv file into lines. Ordinary `KEY=value` assignments (with
 * optional single/double quotes) are extracted; comments, blanks, and
 * malformed lines are preserved verbatim and never interpreted as names.
 */
export function parseDotenvLines(content: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      lines.push({ raw, kind: "other" });
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 1 || !/^[A-Z_][A-Z0-9_]*$/.test(trimmed.slice(0, eq))) {
      lines.push({ raw, kind: "other" });
      continue;
    }
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    lines.push({ key, value, raw, kind: "assignment" });
  }
  return lines;
}

interface Assignment {
  key: string;
  value: string;
  fileIdx: number;
  lineIdx: number;
  raw: string;
}

/**
 * Run the migration decision matrix across the given files.
 *
 * Order of operations per key:
 *   1. validate name / skip policy (WEB_AUTH) / skip empty values
 *   2. compare against the authoritative store
 *   3. commit the secret FIRST when a write is needed
 *   4. only then mark the plaintext assignments for removal
 *
 * Rejected keys never remove source lines and are returned in
 * envKeysToUnset so the orchestrator can drop their file-loaded values.
 */
export function runSecretMigration(
  files: InputFile[],
  io: SecretIO,
  opts: { skipKeys?: ReadonlySet<string> } = {},
): MigrationResult {
  const skip = opts.skipKeys ?? new Set<string>();

  const parsed = files.map(f => parseDotenvLines(f.content));
  const assignments: Assignment[] = [];
  parsed.forEach((lines, fileIdx) => {
    lines.forEach((line, lineIdx) => {
      if (line.kind === "assignment" && isSecretEnvName(line.key)) {
        assignments.push({ key: line.key, value: line.value, fileIdx, lineIdx, raw: line.raw });
      }
    });
  });

  const byKey = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const list = byKey.get(a.key) ?? [];
    list.push(a);
    byKey.set(a.key, list);
  }

  const decisions: MigrationDecision[] = [];
  const removeLines = new Map<number, Set<number>>(); // fileIdx → lineIdx set
  const envKeysToUnset: string[] = [];
  const committedSecrets: string[] = [];
  const removedByFile: Array<{ path: string; keys: string[] }> = [];

  const sourcesFor = (list: Assignment[]): string[] =>
    [...new Set(list.map(a => files[a.fileIdx]!.path.split("/").pop() ?? files[a.fileIdx]!.path))].sort();

  const markForRemoval = (list: Assignment[]) => {
    for (const a of list) {
      let set = removeLines.get(a.fileIdx);
      if (!set) { set = new Set(); removeLines.set(a.fileIdx, set); }
      set.add(a.lineIdx);
    }
  };

  for (const key of [...byKey.keys()].sort()) {
    const list = byKey.get(key)!;
    const sources = sourcesFor(list);
    if (skip.has(key)) continue;

    // Distinct non-empty values. All-empty assignments are not migratable.
    const values = [...new Set(list.map(a => a.value).filter(v => v.length > 0))];
    if (values.length === 0) continue;

    const unsetAndReject = (outcome: MigrationOutcome, reason: string) => {
      decisions.push({ key, outcome, sources, reason });
      envKeysToUnset.push(key);
    };

    if (values.length === 1) {
      const v = values[0]!;
      let cmp: ReturnType<SecretIO["compare"]>;
      try { cmp = io.compare(key, v); }
      catch (err) { unsetAndReject("rejected-unsafe", `store compare failed: ${err instanceof Error ? err.message : String(err)}`); continue; }

      switch (cmp) {
        case "missing": {
          try {
            io.commit(key, v);
            committedSecrets.push(key);
          } catch (err) {
            unsetAndReject("rejected-unsafe", `write failed: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          decisions.push({ key, outcome: "migrated", sources });
          markForRemoval(list);
          break;
        }
        case "equal":
          decisions.push({ key, outcome: "kept-existing", sources });
          markForRemoval(list);
          break;
        case "different":
          decisions.push({ key, outcome: "conflict-kept-existing", sources });
          markForRemoval(list);
          break;
        case "unreadable":
          unsetAndReject("rejected-unsafe", "existing secret could not be verified");
          break;
      }
      continue;
    }

    // Multiple distinct plaintext values.
    let cmp: ReturnType<SecretIO["compare"]>;
    try { cmp = io.compare(key, values[0]!); }
    catch (err) { unsetAndReject("rejected-unsafe", `store compare failed: ${err instanceof Error ? err.message : String(err)}`); continue; }
    if (cmp === "missing") {
      unsetAndReject("rejected-conflict", "conflicting plaintext values and no stored secret");
    } else if (cmp === "unreadable") {
      unsetAndReject("rejected-unsafe", "existing secret could not be verified");
    } else {
      // An authoritative secret exists and is readable — it wins.
      decisions.push({ key, outcome: "conflict-kept-existing", sources });
      markForRemoval(list);
    }
  }

  const filesOut: Array<{ path: string; content: string }> = [];
  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const toRemove = removeLines.get(fileIdx);
    if (!toRemove || toRemove.size === 0) continue;
    const lines = parsed[fileIdx]!;
    const kept = lines.filter((_, i) => !toRemove.has(i)).map(l => l.raw);
    filesOut.push({ path: files[fileIdx]!.path, content: kept.join("\n") });
    const keys = [...byKey.keys()].filter(k => {
      const list = byKey.get(k)!;
      return !skip.has(k) && list.some(a => a.fileIdx === fileIdx && toRemove.has(a.lineIdx));
    }).sort();
    if (keys.length > 0) removedByFile.push({ path: files[fileIdx]!.path, keys });
  }

  return { decisions, files: filesOut, removedByFile, envKeysToUnset, committedSecrets };
}
