/**
 * SkillWatcher — detects new/changed skill files for hot-reload via heartbeat.
 * Generates skills_catalog.md on startup + when skills change.
 */

import { logAndSwallow } from "./log-and-swallow.js";
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
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

export class SkillWatcher implements ISkillSlot {
  private mtimes = new Map<string, number>();
  private firstTick = true;

  constructor(private skillsDir: string, private catalogPath: string) {}

  /** Scan skills dir, return new/changed skills since last check. */
  checkForChanges(): NewSkill[] {
    const files = this.scanMdFiles(this.skillsDir);
    const changed: NewSkill[] = [];

    for (const filepath of files) {
      try {
        const mtime = statSync(filepath).mtimeMs;
        const key = basename(filepath);
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
    for (const filepath of files) {
      const { name, description } = this.parseSkillHeader(filepath);
      if (name) entries.push(`- ${name}: ${description}`);
    }
    const content = `# Skills Catalog\n\n${entries.join("\n")}\n`;
    try {
      writeFileSync(this.catalogPath, content, "utf-8");
      logInfo(TAG, `Generated skills_catalog.md (${entries.length} skills)`);
    } catch (err) {
      logWarn(TAG, `Failed to write skills_catalog.md: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private scanMdFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...this.scanMdFiles(full));
        else if (entry.name.endsWith(".md") && entry.name !== "TOOLS.md" && entry.name !== "skills_catalog.md") results.push(full);
      }
    } catch (err) { logAndSwallow("skill_watcher", "op", err); }
    return results;
  }

  private parseSkillHeader(filepath: string): { name: string; description: string } {
    try {
      const content = readFileSync(filepath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim());
      const heading = lines.find(l => l.startsWith("#"));
      const name = heading?.replace(/^#+\s*/, "").trim() ?? basename(filepath, ".md");
      const desc = lines.find(l => !l.startsWith("#") && l.trim().length > 10)?.trim() ?? "";
      return { name, description: desc.slice(0, 120) };
    } catch {
      return { name: basename(filepath, ".md"), description: "" };
    }
  }
}
