/**
 * pi-runtime-host.test.ts — #1755 RPC session-dir containment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSessionDirArgs } from "./config.js";
import { buildNativeHandoffArgs } from "../../cli/commands/tui-coding-handoff.js";
import type { NativeCodingHandoffInfo } from "../../platforms/tui/tui-protocol.js";

const fake = vi.hoisted(() => {
  class FakeClient {
    static lastArgs: unknown[] | null = null;
    static lastCommand: string | null = null;
    async launch(command: string, args: readonly string[], _cwd: string, _env: Record<string, string>): Promise<void> {
      FakeClient.lastCommand = command;
      FakeClient.lastArgs = [...args];
    }
    async close(): Promise<void> {}
  }
  return { FakeClient };
});

vi.mock("./pi-rpc-client.js", () => ({
  SupervisedPiRpcClient: fake.FakeClient,
  PiRpcError: class PiRpcError extends Error {},
}));

import { PiRuntimeHost } from "./pi-runtime-host.js";
import type { PiExecutorConfig } from "./config.js";

describe("PiRuntimeHost --session-dir (#1755)", () => {
  let wsRoot: string;
  let wsPath: string;

  beforeEach(() => {
    fake.FakeClient.lastArgs = null;
    fake.FakeClient.lastCommand = null;
    wsRoot = mkdtempSync(join(tmpdir(), "pi-host-test-"));
    wsPath = join(wsRoot, "ws");
    mkdirSync(wsPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("RPC launch args contain --session-dir <sessionStorageRoot>", async () => {
    const config: PiExecutorConfig = {
      enabled: true,
      command: "fake-pi",
      fixedArgs: [],
      workspaceAliases: { "repo-a": { path: wsPath } },
      allowedEnv: [],
      maxConcurrent: 1,
      maxWallClockMs: 60000,
      abortGraceMs: 5000,
      projectTrust: "never",
      sessionStorageRoot: "/state/pi",
    };
    const host = new PiRuntimeHost(config);
    const result = await host.launch({
      workspaceAlias: "repo-a",
      envIdentity: { id: "r1", ownerPrincipalId: "u1", executionGeneration: 1 },
    });
    expect(result.ok).toBe(true);
    const args = fake.FakeClient.lastArgs as string[];
    expect(args).toContain("--session-dir");
    expect(args[args.indexOf("--session-dir") + 1]).toBe("/state/pi");
    // fixedArgs + --extension handling unchanged — --mode rpc still present
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("rpc");
  });

  it("both launch paths emit an identical session-dir pair (two-path drift guard)", async () => {
    const sessionStorageRoot = "/state/pi";
    const config: PiExecutorConfig = {
      enabled: true,
      command: "fake-pi",
      fixedArgs: [],
      workspaceAliases: { "repo-a": { path: wsPath } },
      allowedEnv: [],
      maxConcurrent: 1,
      maxWallClockMs: 60000,
      abortGraceMs: 5000,
      projectTrust: "never",
      sessionStorageRoot,
    };
    const host = new PiRuntimeHost(config);
    await host.launch({
      workspaceAlias: "repo-a",
      envIdentity: { id: "r1", ownerPrincipalId: "u1", executionGeneration: 1 },
    });
    const rpcArgs = fake.FakeClient.lastArgs as string[];
    const rpcPair: readonly string[] = rpcArgs.slice(rpcArgs.indexOf("--session-dir"), rpcArgs.indexOf("--session-dir") + 2);

    const handoff: NativeCodingHandoffInfo = {
      sessionId: "spin-c-1",
      workspaceAlias: "repo-a",
      canonicalPath: wsPath,
      memoryMode: "none",
      sessionStorageRoot,
      piSessionId: "sess-1",
      piSessionFile: `${sessionStorageRoot}/--ws--/2026-08-13T00-00-00-000Z_sess-1.jsonl`,
    };
    const clientConfig = { fixedArgs: [] as readonly string[], projectTrust: "never" as const, aliases: {} };
    const tuiArgs = buildNativeHandoffArgs(handoff, clientConfig);
    const tuiPair = tuiArgs.slice(tuiArgs.indexOf("--session-dir"), tuiArgs.indexOf("--session-dir") + 2);

    // The helper is the single spelling — the two vectors must match.
    expect(rpcPair).toEqual(["--session-dir", sessionStorageRoot]);
    expect(tuiPair).toEqual(["--session-dir", sessionStorageRoot]);
    expect(rpcPair).toEqual(tuiPair);
    expect(buildSessionDirArgs(config)).toEqual(["--session-dir", sessionStorageRoot]);
  });
});
