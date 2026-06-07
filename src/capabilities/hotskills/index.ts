/**
 * Skills capability — on-demand skill catalog reload via /skill command.
 */

import { join } from "node:path";
import { SkillWatcher, type SkillInfo } from "../../components/skill-watcher.js";
import { abtarsHome } from "../../paths.js";
import type { CapabilityApi } from "../capability.js";

let _instance: SkillWatcher | null = null;

/** Get cached skill info from the last catalog generation. */
export function getSkillCache(): readonly SkillInfo[] { return _instance?.skills ?? []; }

export function register(api: CapabilityApi): void {
  const skillWatcher = new SkillWatcher(
    join(abtarsHome(), "skills"),
    join(abtarsHome(), "core", "skills_catalog.md"),
  );
  _instance = skillWatcher;

  // Generate catalog on startup
  skillWatcher.generateCatalog();

  api.registerCommand("skill", async (_text, ctx) => {
    const count = skillWatcher.generateCatalog();
    await ctx.reply(`Reloaded — ${count} skills available.`);
    return true;
  });
}
