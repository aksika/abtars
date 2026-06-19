import { logInfo, logError } from "../../components/logger.js";
import { getEnv } from "../../components/env-schema.js";
/**
 * Browser capability — browse-spawn IPC.
 * Level 1 (lightpanda fetch) is handled by the agent via skill — no bridge code needed.
 * Level 2 (Browsie) uses spin.dispatch() via IPC socket.
 */

import { BrowserManager } from "./browser-manager.js";
import { BrowserTool } from "./browser-tool.js";
import { BrowserIpcServer } from "./browser-ipc-server.js";
import { DomainAllowlist } from "./domain-allowlist.js";
import { abtarsHome } from "../../paths.js";
import type { CapabilityApi } from "../capability.js";
import * as net from "node:net";
import { join } from "node:path";
import { unlinkSync, mkdirSync, chmodSync } from "node:fs";

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

  // Browse-spawn IPC — CLI sends task, bridge dispatches via Spin
  const spawnSocketPath = join(abtarsHome(), "browser-socket", "browse-spawn.sock");
  try {
    mkdirSync(join(abtarsHome(), "browser-socket"), { recursive: true, mode: 0o700 });
    try { unlinkSync(spawnSocketPath); } catch { /* doesn't exist */ }
    try { chmodSync(join(abtarsHome(), "browser-socket"), 0o700); } catch { /* best effort */ }

    const spawnServer = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);

        try {
          const { taskId, prompt, timeoutMs } = JSON.parse(line);

          // #900: dispatch via Spin — kanban tracks, Nerve delivers result
          import("../../components/spin.js").then(({ spin: s }) => {
            const { cardId } = s.dispatch({ type: "B", goal: prompt, source: "agent", deliveryMode: "announce", timeoutMs });
            conn.write(JSON.stringify({ ok: true, taskId, cardId, status: "spawned" }) + "\n");
          }).catch((err) => {
            conn.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
          });
        } catch (err) {
          conn.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
        }
      });
      conn.on("error", () => {});
    });

    spawnServer.on("error", (err: Error) => {
      logError("browser", `⚠️ Browse-spawn IPC socket error — browser degraded: ${err.message}`);
    });

    spawnServer.listen(spawnSocketPath, () => {
      logInfo("browser", `🔌 Browse spawn IPC listening on ${spawnSocketPath}`);
    });
  } catch (err) {
    logError("browser", `⚠️ Browse-spawn IPC failed — browser disabled: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Ensure browser IPC is available (lazy start on first heartbeat)
  api.registerHeartbeatTask({
    name: "browser-ipc-ensure",
    execute: ensureBrowserIpc,
  });
}
