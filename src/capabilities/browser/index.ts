/**
 * Browser capability — browse-checker heartbeat + IPC server.
 */

import { BrowserManager } from "../../components/browser-manager.js";
import { BrowserTool } from "../../components/browser-tool.js";
import { BrowserIpcServer } from "../../components/browser-ipc-server.js";
import { DomainAllowlist } from "../../components/domain-allowlist.js";
import { checkBrowseTasks } from "../../components/cron-checker.js";
import { logInfo } from "../../components/logger.js";
import type { CapabilityApi } from "../capability.js";

export function register(api: CapabilityApi): void {
  const browserManager = new BrowserManager();
  const allowlist = DomainAllowlist.fromEnv();
  const browserTool = new BrowserTool(browserManager, allowlist);
  let browserIpc: BrowserIpcServer | null = null;

  const ensureBrowserIpc = async (): Promise<void> => {
    if (browserIpc || process.env["BROWSER_DOCKER"] === "1") return;
    browserIpc = new BrowserIpcServer(browserTool);
    await browserIpc.start();
    logInfo("browser", `🔌 Browser IPC listening on ${browserIpc.socketPath}`);
  };

  api.registerHeartbeatTask({
    name: "browse-checker",
    execute: async () => { await ensureBrowserIpc(); checkBrowseTasks(); },
  });
}
