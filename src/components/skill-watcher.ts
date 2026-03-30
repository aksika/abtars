/**
 * SkillWatcher — detects new/changed skill files for hot-reload via heartbeat.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { appendFileSync } from "node:fs";
import { logInfo } from "./logger.js";

const TAG = "skill-reloader";

export interface NewSkill {
  filename: string;
  name: string;
  description: string;
  path: string;
}

export class SkillWatcher {
  private mtimes = new Map<string, number>();
  private firstTick = true;

  constructor(private skillsDir: string, private toolsPath: string) {}

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
        if (name) changed.push({ filename: key, name, description, path: filepath });
      } catch { /* skip unreadable files */ }
    }

    this.firstTick = false;
    return changed;
  }

  /** Append a 1-liner to TOOLS.md if not already present. */
  appendToTools(skill: NewSkill): void {
    try {
      const tools = readFileSync(this.toolsPath, "utf-8");
      if (tools.includes(skill.name)) return; // already listed
      appendFileSync(this.toolsPath, `\n- ${skill.name}: ${skill.description}`);
      logInfo(TAG, `Appended to TOOLS.md: ${skill.name}`);
    } catch { /* TOOLS.md may not exist */ }
  }

  private scanMdFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...this.scanMdFiles(full));
        else if (entry.name.endsWith(".md") && entry.name !== "TOOLS.md") results.push(full);
      }
    } catch { /* dir may not exist */ }
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
