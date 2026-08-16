/**
 * Skills capability — on-demand skill catalog reload via /skill command.
 */

import { join } from "node:path";
import { SkillWatcher, type SkillInfo } from "../../components/skill-watcher.js";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import type { CapabilityApi } from "../capability.js";

let _instance: SkillWatcher | null = null;

/** Get cached skill info from the last catalog generation. */
export function getSkillCache(): readonly SkillInfo[] { return _instance?.skills ?? []; }

/**
 * Reload the skills catalog (#1542): prepares declared skill dependencies
 * (no-op for absent/empty declarations) before regenerating the catalog.
 * Returns the number of admitted skills.
 */
export async function reloadCatalog(): Promise<number> {
  if (!_instance) return 0;
  const count = await _instance.prepareAndGenerateCatalog();
  return count;
}

export function register(_api: CapabilityApi): void {
  const skillWatcher = new SkillWatcher(
    join(abtarsHome(), "skills"),
    join(abtarsHome(), "skills", "skills_catalog.md"),
  );
  _instance = skillWatcher;

  // Generate catalog on startup. #1542: dependency preparation happens at
  // this controlled lifecycle boundary. Fire-and-forget — the catalog is
  // regenerated when /skill reload is issued, so failure is non-fatal here.
  // #1432: no competing /skill registration — the canonical handler in
  // handlers-admin.ts owns /skill (run|stop|list|reload).
  skillWatcher.prepareAndGenerateCatalog().catch(err => logAndSwallow("hotskills", "prepare skill catalog at startup", err));
}
