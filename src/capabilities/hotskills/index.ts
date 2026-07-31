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

/** Reload the skills catalog. Returns skill count. */
export function reloadCatalog(): number { return _instance?.generateCatalog() ?? 0; }

export function register(_api: CapabilityApi): void {
  const skillWatcher = new SkillWatcher(
    join(abtarsHome(), "skills"),
    join(abtarsHome(), "skills", "skills_catalog.md"),
  );
  _instance = skillWatcher;

  // Generate catalog on startup.
  // #1432: no competing /skill registration — the canonical handler in
  // handlers-admin.ts owns /skill (run|stop|list|reload).
  skillWatcher.generateCatalog();
}
