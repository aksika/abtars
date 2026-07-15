/**
 * pi-rpc-real-binary.test.ts — #1426 Task 5: real-binary RPC contract smoke.
 *
 * Launches the development @earendil-works/pi-coding-agent CLI in RPC mode with
 * an isolated HOME/workspace (no credentials, no network, no model call) and
 * proves the supervised transport speaks the official protocol end-to-end:
 *   - response is a correlated official {type:"response", id, command, success, data};
 *   - session state projects official RpcSessionState fields;
 *   - the process shuts down cleanly on close.
 *
 * Skips automatically when the dev package CLI is not installed so the suite
 * remains green in environments without the dev dependency.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisedPiRpcClient } from "./pi-rpc-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const CLI_PATH = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const hasDevBinary = existsSync(CLI_PATH);

let homeDir: string | undefined;
let workspaceDir: string | undefined;

describe.skipIf(!hasDevBinary)("SupervisedPiRpcClient real-binary contract (#1426)", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "pi-rpc-home-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "pi-rpc-ws-"));
  });

  it("boots RPC mode offline and resolves an official correlated get_state response", async () => {
    const client = new SupervisedPiRpcClient();
    const args = [CLI_PATH, "--mode", "rpc", "--no-approve"];
    const env = {
      HOME: homeDir!,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    try {
      await client.launch(process.execPath, args, workspaceDir!, env);
      expect(typeof client.pid).toBe("number");

      const state = await client.getState();
      // Official RpcSessionState projection.
      expect(state.sessionId).toBeTruthy();
      expect(typeof state.sessionId).toBe("string");
      expect(state.isStreaming).toBe(false);
      expect(state.sessionFile).toBeTruthy();
      // Session storage is contained under the isolated HOME.
      expect(state.sessionFile!).toContain(homeDir);
    } finally {
      await client.close();
    }
  }, 20000);

  it("uses the official command/response shapes (no invented envelope or unsupported flags)", async () => {
    const clientSrc = readFileSync(join(ROOT, "src", "components", "pi-executor", "pi-rpc-client.ts"), "utf-8");
    expect(clientSrc).not.toContain(`"cmd"`);
    expect(clientSrc).not.toContain(`"args"`);
    expect(clientSrc).not.toContain(`--rpc-version`);
    expect(clientSrc).not.toContain(`--session-storage-root`);
  });
});

afterAll(() => {
  for (const d of [homeDir, workspaceDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});
