import { logAndSwallow } from "../../components/log-and-swallow.js";
import { getEnv } from "../../components/env-schema.js";
/**
 * Browser capability — browse-spawn IPC + browse-checker heartbeat.
 * Level 1 (lightpanda fetch) is handled by the agent via skill — no bridge code needed.
 * Level 2 (Browsie) uses runtime.spawn() via IPC socket.
 */

import { BrowserManager } from "./browser-manager.js";
import { BrowserTool } from "./browser-tool.js";
import { BrowserIpcServer } from "./browser-ipc-server.js";
import { DomainAllowlist } from "./domain-allowlist.js";
import { checkBrowseTasks, deliverBrowseResult } from "./browse-delivery.js";
import { readPendingBrowse, writePendingBrowse } from "./abtars-browse.js";
import type { PendingBrowseEntry } from "./abtars-browse.js";
import { logInfo, logWarn } from "../../components/logger.js";
import { abtarsHome } from "../../paths.js";
import type { CapabilityApi } from "../capability.js";
import * as net from "node:net";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

export function register(api: CapabilityApi): void {
  const browserManager = new BrowserManager();
  const allowlist = DomainAllowlist.fromEnv();
  const browserTool = new BrowserTool(browserManager, allowlist);
  let browserIpc: BrowserIpcServer | null = null;

  const ensureBrowserIpc = async (): Promise<void> => {
    if (browserIpc || getEnv().browserDocker) return;
    browserIpc = new BrowserIpcServer(browserTool);
    await browserIpc.start();
    logInfo("browser", `🔌 Browser IPC listening on ${browserIpc.socketPath}`);
  };

  // Browse-spawn IPC — CLI sends task, bridge spawns via runtime
  const spawnSocketPath = join(abtarsHome(), "browse-spawn.sock");
  try { unlinkSync(spawnSocketPath); } catch (err) { logAndSwallow("index", "op", err); }

  const spawnServer = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);

      try {
        const { taskId, task, prompt, chatId, threadId, timeoutMs } = JSON.parse(line);

        const entry: PendingBrowseEntry = {
          taskId, task, chatId, threadId,
          pid: process.pid, // bridge pid — runtime manages the actual transport
          startedAt: Date.now(), timeoutMs,
          logFile: "", // no log file — result comes from callback
        };
        const entries = readPendingBrowse();
        entries.push(entry);
        writePendingBrowse(entries);

        // Fire-and-forget via runtime
        api.runtime.spawn("browsie", prompt, {
          timeoutMs,
          onComplete: (_id: string, result: string) => {
            deliverBrowseResult(entry, result);
            const remaining = readPendingBrowse().filter(e => e.taskId !== taskId);
            writePendingBrowse(remaining);
          },
          onError: (_id: string, err: Error) => {
            logWarn("browser", `Browsie spawn failed for ${taskId}: ${err.message}`);
            deliverBrowseResult(entry, `Browse task failed: ${err.message}`);
            const remaining = readPendingBrowse().filter(e => e.taskId !== taskId);
            writePendingBrowse(remaining);
          },
        }).then(({ taskId: spawnId }) => {
          conn.write(JSON.stringify({ ok: true, taskId, spawnId, status: "spawned" }) + "\n");
        }).catch((err) => {
          conn.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
        });
      } catch (err) {
        conn.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
      }
    });
    conn.on("error", () => {});
  });

  spawnServer.listen(spawnSocketPath, () => {
    logInfo("browser", `🔌 Browse spawn IPC listening on ${spawnSocketPath}`);
  });

  api.registerHeartbeatTask({
    name: "browse-checker",
    execute: async () => { await ensureBrowserIpc(); checkBrowseTasks(); },
  });
}
