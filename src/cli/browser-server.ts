#!/usr/bin/env node
/**
 * Standalone browser IPC server — runs inside Docker.
 * Starts BrowserManager + BrowserTool + IPC socket, then waits for SIGTERM.
 */
import { BrowserManager } from "../components/browser-manager.js";
import { BrowserTool } from "../components/browser-tool.js";
import { BrowserIpcServer } from "../components/browser-ipc-server.js";
import { DomainAllowlist } from "../components/domain-allowlist.js";

const SOCKET_PATH = process.env["BROWSER_SOCKET_PATH"] ?? "/run/browser/browser.sock";

async function main(): Promise<void> {
  const manager = new BrowserManager();
  const allowlist = DomainAllowlist.fromEnv();
  const tool = new BrowserTool(manager, allowlist);
  const ipc = new BrowserIpcServer(tool, SOCKET_PATH);

  await ipc.start();
  console.log(`[browser-server] Listening on ${SOCKET_PATH}`);

  const shutdown = async (): Promise<void> => {
    console.log("[browser-server] Shutting down...");
    await ipc.shutdown();
    await manager.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  console.error("[browser-server] Fatal:", err);
  process.exit(1);
});
