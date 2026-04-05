/**
 * Skills capability — hot-reload skill files and inject into agent.
 */

import { join } from "node:path";
import { SkillWatcher } from "../../components/skill-watcher.js";
import { logInfo } from "../../components/logger.js";
import { agentBridgeHome } from "../../paths.js";
import type { CapabilityApi } from "../capability.js";

export function register(api: CapabilityApi): void {
  const skillWatcher = new SkillWatcher(
    join(agentBridgeHome(), "skills"),
    join(agentBridgeHome(), "skills", "TOOLS.md"),
  );

  api.registerHeartbeatTask({
    name: "skill-reloader",
    execute: async () => {
      const changed = skillWatcher.checkForChanges();
      for (const skill of changed) {
        skillWatcher.appendToTools(skill);
        const chatId = [...api.config.telegram.allowedUserIds][0];
        if (chatId) {
          const msg = `[NEW SKILL AVAILABLE] ${skill.name}: ${skill.description}. Read ${skill.path} if you need it.`;
          await api.transport.sendPrompt(`telegram:${chatId}`, msg);
          logInfo("skill-reloader", `Injected: ${skill.name}`);
        }
      }
    },
  });
}
