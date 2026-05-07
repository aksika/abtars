/**
 * SkillWatcher — detects new/changed skill files for hot-reload via heartbeat.
 * Generates skills_catalog.md on startup + when skills change.
 *
 * #369 — Parses YAML-style frontmatter to extract name/description/requires.
 * #412 — Structured requires: bins/npm/env/files (OpenClaw pattern).
 *        Skills declare their own deps; loader checks eligibility at boot.
 */

import { logAndSwallow } from "./log-and-swallow.js";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { logInfo, logWarn } from "./logger.js";
import { scanForInjection } from "abmind";

import type { ISkillSlot } from "./skeleton.js";

const TAG = "skill-reloader";

export interface NewSkill {
  filename: string;
  name: string;
  description: string;
  path: string;
}

/** Structured skill requirements (#412). */
interface SkillRequires {
  bins?: string[];
  npm?: string[];
  env?: string[];
  files?: string[];
}

interface SkillHeader {
  name: string;
  description: string;
  requires?: SkillRequires;
}

export class SkillWatcher implements ISkillSlot {
  private mtimes = new Map<string, number>();
  private firstTick = true;
  /** Per-instance cache of `which <bin>` results. Avoids repeated execFileSync on heartbeat ticks (#369). */
  private binaryCache = new Map<string, boolean>();

  constructor(private skillsDir: string, private catalogPath: string) {}

  /** Scan skills dir, return new/changed skills since last check. */
  checkForChanges(): NewSkill[] {
    const files = this.scanMdFiles(this.skillsDir);
    const changed: NewSkill[] = [];

    for (const filepath of files) {
      try {
        const mtime = statSync(filepath).mtimeMs;
        const key = basename(dirname(filepath));
        const prev = this.mtimes.get(key);
        this.mtimes.set(key, mtime);

        if (this.firstTick) continue; // skip first tick — already loaded by kiro-cli
        if (prev !== undefined && mtime <= prev) continue; // unchanged

        const { name, description } = this.parseSkillHeader(filepath);
        if (name) {
          const content = readFileSync(filepath, "utf-8");
          const scan = scanForInjection(content);
          if (!scan.safe) {
            const top = scan.flags[0]!;
            logWarn(TAG, `BLOCKED skill "${key}" — injection detected: ${top.category} (score=${scan.score})`);
            continue;
          }
          changed.push({ filename: key, name, description, path: filepath });
        }
      } catch (err) { logAndSwallow("skill_watcher", "op", err); }
    }

    if (!this.firstTick && changed.length > 0) this.generateCatalog();
    this.firstTick = false;
    return changed;
  }

  /** Generate skills_catalog.md from all skill files. Called on startup + when skills change. */
  generateCatalog(): void {
    const files = this.scanMdFiles(this.skillsDir);
    const entries: string[] = [];
    const skipped: string[] = [];
    for (const filepath of files) {
      const header = this.parseSkillHeader(filepath);
      if (!header.name) continue;
      if (header.requires) {
        const { eligible, missing } = this.checkEligibility(header.requires);
        if (!eligible) {
          skipped.push(`${header.name} (missing: ${missing.join(", ")})`);
          continue;
        }
      }
      entries.push(`- [${this.getSourceDir(filepath)}] ${header.name}: ${header.description}`);
    }
    const content = `# Skills Catalog\n\n${entries.join("\n")}\n`;
    try {
      writeFileSync(this.catalogPath, content, "utf-8");
      const skippedStr = skipped.length > 0 ? `, ${skipped.length} skipped — ${skipped.join(", ")}` : "";
      logInfo(TAG, `Generated skills_catalog.md (${entries.length} skills${skippedStr})`);
    } catch (err) {
      logWarn(TAG, `Failed to write skills_catalog.md: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Check all requirements. Returns eligible=true only if ALL pass. */
  private checkEligibility(requires: SkillRequires): { eligible: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const bin of requires.bins ?? []) {
      if (!this.binaryAvailable(bin)) missing.push(`bin:${bin}`);
    }
    for (const pkg of requires.npm ?? []) {
      if (!this.npmAvailable(pkg)) missing.push(`npm:${pkg}`);
    }
    for (const key of requires.env ?? []) {
      if (!process.env[key]) missing.push(`env:${key}`);
    }
    for (const file of requires.files ?? []) {
      const resolved = resolve(file.replace(/^~/, homedir()));
      if (!existsSync(resolved)) missing.push(`file:${file}`);
    }
    return { eligible: missing.length === 0, missing };
  }

  /** Check if an npm package is resolvable from the abtars node_modules. */
  private npmAvailable(pkg: string): boolean {
    try {
      require.resolve(pkg);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if a binary is on PATH. Cached per-instance so hot-reload ticks don't respawn `which`. */
  private binaryAvailable(bin: string): boolean {
    if (!this.binaryCache.has(bin)) {
      try {
        // execFileSync (not execSync) — no shell interpolation on untrusted `requires:` values.
        execFileSync("which", [bin], { timeout: 1000, stdio: "pipe" });
        this.binaryCache.set(bin, true);
      } catch {
        this.binaryCache.set(bin, false);
      }
    }
    return this.binaryCache.get(bin)!;
  }

  private getSourceDir(filepath: string): string {
    const rel = filepath.slice(this.skillsDir.length + 1);
    const first = rel.split("/")[0] ?? "core";
    if (["core", "custom", "downloaded", "self"].includes(first)) return first;
    return "core";
  }

  private scanMdFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...this.scanMdFiles(full));
        else if (entry.name === "SKILL.md") results.push(full);
      }
    } catch (err) { logAndSwallow("skill_watcher", "op", err); }
    return results;
  }

  /**
   * Parse a skill file's header.
   *
   * Preferred: YAML-style frontmatter block at the top of the file:
   *   ---
   *   name: mcporter
   *   description: Call external MCP servers via the mcporter CLI.
   *   requires: mcporter
   *   ---
   *
   * Supports only single-line `key: value` pairs. No arrays, no nested
   * objects, no multi-line strings, no comments. Values are trimmed.
   *
   * Fallback (no frontmatter): first `#` heading → name, first non-heading
   * line > 10 chars → description. Preserves pre-#369 behavior for any
   * skills that don't yet have frontmatter.
   */
  private parseSkillHeader(filepath: string): SkillHeader {
    try {
      const content = readFileSync(filepath, "utf-8");
      const fm = this.parseFrontmatter(content);
      if (fm) {
        return {
          name: String(fm["name"] ?? "") || basename(dirname(filepath)),
          description: String(fm["description"] ?? "").slice(0, 120),
          ...(fm["requires"] ? { requires: this.parseRequires(fm["requires"]) } : {}),
        };
      }

      // Fallback for skill files without frontmatter
      const lines = content.split("\n").filter(l => l.trim());
      const heading = lines.find(l => l.startsWith("#"));
      const name = heading?.replace(/^#+\s*/, "").trim() ?? basename(dirname(filepath));
      const desc = lines.find(l => !l.startsWith("#") && l.trim().length > 10)?.trim() ?? "";
      return { name, description: desc.slice(0, 120) };
    } catch {
      return { name: basename(dirname(filepath)), description: "" };
    }
  }

  /** Parse requires field: string → { bins: [str] }, object → SkillRequires. */
  private parseRequires(raw: unknown): SkillRequires {
    if (typeof raw === "string") return { bins: [raw] };
    if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      return {
        ...(obj["bins"] ? { bins: toStringArray(obj["bins"]) } : {}),
        ...(obj["npm"] ? { npm: toStringArray(obj["npm"]) } : {}),
        ...(obj["env"] ? { env: toStringArray(obj["env"]) } : {}),
        ...(obj["files"] ? { files: toStringArray(obj["files"]) } : {}),
      };
    }
    return {};
  }

  /**
   * Extract frontmatter key/value pairs. Returns null if the file doesn't
   * start with a `---` fence.
   *
   * Supports: flat `key: value`, inline arrays `key: [a, b]`, and one level
   * of nesting via indented keys under a parent.
   */
  private parseFrontmatter(content: string): Record<string, unknown> | null {
    const lines = content.split("\n");
    let i = 0;
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length || lines[i]!.trim() !== "---") return null;

    const start = i + 1;
    let end = -1;
    for (let j = start; j < lines.length; j++) {
      if (lines[j]!.trim() === "---") { end = j; break; }
    }
    if (end === -1) return null;

    const result: Record<string, unknown> = {};
    let currentParent: string | null = null;
    let currentObj: Record<string, unknown> = {};

    for (let j = start; j < end; j++) {
      const line = lines[j]!;
      if (line.trim() === "") continue;

      const indent = line.length - line.trimStart().length;
      const colonIdx = line.indexOf(":");
      if (colonIdx < 1) continue;

      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const rawValue = line.slice(colonIdx + 1).trim();

      if (indent > 0 && currentParent) {
        // Nested key under parent
        currentObj[key] = parseYamlValue(rawValue);
      } else {
        // Top-level key
        if (currentParent) {
          result[currentParent] = currentObj;
          currentParent = null;
          currentObj = {};
        }
        if (rawValue === "" || rawValue === "|" || rawValue === ">") {
          // Start of nested object
          currentParent = key;
          currentObj = {};
        } else {
          result[key] = parseYamlValue(rawValue);
        }
      }
    }
    if (currentParent) result[currentParent] = currentObj;

    return result;
  }
}

/** Parse a YAML value: inline array [a, b] → string[], otherwise string. */
function parseYamlValue(raw: string): unknown {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return raw;
}

/** Coerce unknown to string[]. */
function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return [];
}
