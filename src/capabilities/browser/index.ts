import { logInfo, logError } from "../../components/logger.js";
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

  // Browse-spawn IPC — CLI sends task, bridge spawns via runtime
  const spawnSocketPath = join(abtarsHome(), "browser-socket", "browse-spawn.sock");
  try {
    mkdirSync(join(abtarsHome(), "browser-socket"), { recursive: true, mode: 0o700 });
    try { unlinkSync(spawnSocketPath); } catch { /* doesn't exist — fine */ }
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

        // Fire-and-forget via Spin
        import("../../components/spin.js").then(({ spin: s }) => {
          const cardId = s.dispatch({ type: "B", goal: prompt, source: "agent", timeoutMs: timeoutMs });
          conn.write(JSON.stringify({ ok: true, taskId, spawnId: `spin-${cardId}`, status: "spawned" }) + "\n");

          // Track for browse-checker delivery
          const checkDone = setInterval(() => {
            import("../../components/tasks/kanban-board.js").then(({ kanbanList: kl }) => {
              const cards = kl("*").filter((c: { id: number }) => c.id === cardId);
              const card = cards[0];
              if (!card || (card.status !== "done" && card.status !== "failed")) return;
              clearInterval(checkDone);
              if (card.status === "done") {
                deliverBrowseResult(entry, card.result_summary ?? "(no output)");
              } else {
                deliverBrowseResult(entry, `Browse task failed: ${card.error ?? "unknown"}`);
              }
              const remaining = readPendingBrowse().filter(e => e.taskId !== taskId);
              writePendingBrowse(remaining);
            });
          }, 5000);
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

  api.registerHeartbeatTask({
    name: "browse-checker",
    execute: async () => { await ensureBrowserIpc(); checkBrowseTasks(); },
  });
}
