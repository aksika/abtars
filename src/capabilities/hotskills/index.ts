/**
 * Skills capability — hot-reload skill files and inject into agent.
 */

import { join } from "node:path";
import { SkillWatcher } from "../../components/skill-watcher.js";
import { abtarsHome } from "../../paths.js";
import type { CapabilityApi } from "../capability.js";

export function register(api: CapabilityApi): void {
  const skillWatcher = new SkillWatcher(
    join(abtarsHome(), "skills"),
    join(abtarsHome(), "core", "skills_catalog.md"),
  );

  // Generate catalog on startup
  skillWatcher.generateCatalog();

  api.registerHeartbeatTask({
    name: "skill-reloader",
    execute: async () => {
      skillWatcher.checkForChanges();
    },
  });
}
