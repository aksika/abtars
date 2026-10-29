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
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
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

function isolatedEnv(): Record<string, string> {
  return {
    HOME: homeDir!,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
  };
}

/** Bounded poll for the session file to appear on disk. */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (statSync(path).isFile()) return true;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return existsSync(path) && statSync(path).isFile();
}

describe.skipIf(!hasDevBinary)("SupervisedPiRpcClient real-binary contract (#1426/#1647)", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "pi-rpc-home-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "pi-rpc-ws-"));
  });

  it("boots RPC mode offline and resolves an official correlated get_state response", async () => {
    const client = new SupervisedPiRpcClient();
    const args = [CLI_PATH, "--mode", "rpc", "--no-approve"];
    const env = isolatedEnv();
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

  it("#1647 offline process-A/process-B switch_session identity verification", async () => {
    const env = isolatedEnv();
    const processA = new SupervisedPiRpcClient();
    let sessionAFile: string;
    let persistedId: string;
    try {
      await processA.launch(process.execPath, [CLI_PATH, "--mode", "rpc", "--no-approve"], workspaceDir!, env);
      const stateA = await processA.getState();
      expect(stateA.sessionId).toBeTruthy();
      sessionAFile = stateA.sessionFile!;
      expect(sessionAFile).toContain(homeDir);

      // Initialize a persisted session file WITHOUT a model call: switching to
      // an empty file makes Pi write the {"type":"session","id":...} header
      // immediately. This is the header validatePersistedSession() reads.
      mkdirSync(dirname(sessionAFile), { recursive: true });
      writeFileSync(sessionAFile, "", "utf-8");
      const switched = await processA.switchSession(sessionAFile);
      expect(switched.cancelled).toBe(false);
      expect(await waitForFile(sessionAFile, 10_000)).toBe(true);
      const header = JSON.parse(readFileSync(sessionAFile, "utf-8").split("\n", 1)[0]!) as { type?: string; id?: string };
      expect(header.type).toBe("session");
      expect(header.id).toBeTruthy();
      persistedId = header.id!;
      const stateAfter = await processA.getState();
      expect(stateAfter.sessionId).toBe(persistedId);
      expect(stateAfter.sessionFile).toBe(sessionAFile);

      // A SECOND process verifies the saved identity cross-process: switch to
      // A's file and get_state must report the SAME id/file.
      const processB = new SupervisedPiRpcClient();
      try {
        await processB.launch(process.execPath, [CLI_PATH, "--mode", "rpc", "--no-approve"], workspaceDir!, env);
        const stateB = await processB.getState();
        expect(stateB.sessionId).not.toBe(persistedId);
        const switchedB = await processB.switchSession(sessionAFile);
        expect(switchedB.cancelled).toBe(false);
        const stateAfterB = await processB.getState();
        expect(stateAfterB.sessionId).toBe(persistedId);
        expect(stateAfterB.sessionFile).toBe(sessionAFile);
      } finally {
        await processB.close();
      }
    } finally {
      await processA.close();
    }
  }, 30000);
});

afterAll(() => {
  for (const d of [homeDir, workspaceDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});
