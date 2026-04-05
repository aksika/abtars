/**
 * Browser capability — browse-checker heartbeat + IPC server.
 */

import { BrowserManager } from "./browser-manager.js";
import { BrowserTool } from "./browser-tool.js";
import { BrowserIpcServer } from "./browser-ipc-server.js";
import { DomainAllowlist } from "./domain-allowlist.js";
import { checkBrowseTasks, deliverBrowseResult } from "../../components/cron-checker.js";
import { readPendingBrowse, writePendingBrowse } from "./agentbridge-browse.js";
import type { PendingBrowseEntry } from "./agentbridge-browse.js";
import { logInfo } from "../../components/logger.js";
import { agentBridgeHome } from "../../paths.js";
import type { CapabilityApi } from "../capability.js";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

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

  // Browse spawn IPC — CLI sends requests here, bridge owns the child process
  const browseSocketPath = join(agentBridgeHome(), "browse.sock");
  try { unlinkSync(browseSocketPath); } catch { /* */ }

  const browseServer = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);

      try {
        const req = JSON.parse(line);
        const { wrapperFile, logFile, taskId, task, chatId, threadId, timeoutMs, engine } = req;

        const child = spawn("node", [wrapperFile, logFile, req.promptFile], {
          stdio: "ignore",
          env: { ...process.env, ...(engine ? { BROWSER_ENGINE: engine } : {}) },
        });

        const entry: PendingBrowseEntry = { taskId, task, chatId, threadId, pid: child.pid!, startedAt: Date.now(), timeoutMs, logFile };
        const entries = readPendingBrowse();
        entries.push(entry);
        writePendingBrowse(entries);

        // Instant delivery on exit
        child.on("exit", () => {
          deliverBrowseResult(entry);
          const remaining = readPendingBrowse().filter(e => e.taskId !== taskId);
          writePendingBrowse(remaining);
        });

        conn.write(JSON.stringify({ ok: true, taskId, status: "spawned", pid: child.pid }) + "\n");
      } catch (err) {
        conn.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
      }
    });
    conn.on("error", () => {});
  });

  browseServer.listen(browseSocketPath, () => {
    logInfo("browser", `🔌 Browse IPC listening on ${browseSocketPath}`);
  });

  api.registerHeartbeatTask({
    name: "browse-checker",
    execute: async () => { await ensureBrowserIpc(); checkBrowseTasks(); },
  });
}
