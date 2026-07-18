import { logInfo, logError } from "../../components/logger.js";
import { abtarsHome } from "../../paths.js";
import type { CapabilityApi } from "../capability.js";
import * as net from "node:net";
import { join } from "node:path";
import { unlinkSync, mkdirSync, chmodSync } from "node:fs";

export function register(_api: CapabilityApi): void {
  const spawnSocketPath = join(abtarsHome(), "browser-socket", "browse-spawn.sock");
  try {
    mkdirSync(join(abtarsHome(), "browser-socket"), { recursive: true, mode: 0o700 });
    try { unlinkSync(spawnSocketPath); } catch { }
    try { chmodSync(join(abtarsHome(), "browser-socket"), 0o700); } catch { }

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

          import("../../components/spin.js").then(({ spin: s }) => {
            const { cardId } = s.dispatch({ type: "B", goal: prompt, source: "agent", timeoutMs });
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
      logError("browser", `Browse-spawn IPC socket error: ${err.message}`);
    });

    spawnServer.listen(spawnSocketPath, () => {
      logInfo("browser", `Browse spawn IPC listening on ${spawnSocketPath}`);
    });
  } catch (err) {
    logError("browser", `Browse-spawn IPC failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
