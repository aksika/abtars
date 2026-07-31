/**
 * phase-memory — boot phase 2: initialize memory layer.
 *
 * Order of resolution (#1508):
 *   1. disabled memory → no config load, no abmind import, no connect
 *   2. resolve the abtars-owned endpoint descriptor (~/.abtars/config/abmind.json)
 *   3. local mode → loadAbmind() + existing package checks + local client
 *   4. wss mode → abtars-owned signed WSS client; ctx.abmindModule stays null
 *   5. negotiate required capabilities before registering the runtime
 *   6. typed failures map to bounded degraded status; partial clients close;
 *      an explicit endpoint never falls back to another transport
 *
 * Populates ctx: client (AbmindClientLike or null), memoryRuntime,
 * abmindModule (local mode only).
 *
 * Owns no module-level singletons (setMemoryLogger is a setter on abmind's
 * internal logger, not an abtars singleton).
 */

import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { loadAbmind } from "../utils/abmind-lazy.js";
import { createDisabledRuntime, createUnavailableRuntime } from "../components/memory-runtime.js";
import { resolveAbmindEndpoint, AbmindEndpointConfigError, type ResolvedAbmindEndpoint } from "../components/abmind-endpoint-config.js";
import type { AbmindClientLike } from "../components/abmind-client-contract.js";
import type { AbtarsMemoryRuntime } from "../components/memory-runtime.js";
import { AbtarsSignedWssClient } from "../components/abmind-signed-wss-client.js";
import { createClientRuntime } from "../components/memory-runtime.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface MemoryRuntimeFactoryResult {
  mode: "local" | "wss";
  client: AbmindClientLike;
  runtime: AbtarsMemoryRuntime;
  abmindModule: typeof import("abmind") | null;
}

/** Marker error: default local mode with no resolvable abmind package. */
export class AbmindModuleMissingError extends Error {
  constructor() {
    super("abmind package is not installed");
    this.name = "AbmindModuleMissingError";
  }
}

/** Bounded reason codes exposed to boot/status diagnostics for remote endpoints. */
export type MemoryEndpointFailureCode =
  | "endpoint_unavailable"
  | "pin_mismatch"
  | "authentication_failed"
  | "negotiation_failed";

/** WSS endpoint failure carrying a bounded, secret-free reason code. */
export class MemoryEndpointUnavailableError extends Error {
  readonly code: MemoryEndpointFailureCode;

  constructor(code: MemoryEndpointFailureCode, message: string) {
    super(message);
    this.name = "MemoryEndpointUnavailableError";
    this.code = code;
  }
}

function wssFailureCode(err: unknown): MemoryEndpointFailureCode {
  const message = err instanceof Error ? err.message : String(err);
  if (/pin/i.test(message)) return "pin_mismatch";
  if (/auth/i.test(message)) return "authentication_failed";
  if (/connection failed|econnrefused|closed before open|timed out/i.test(message)) return "endpoint_unavailable";
  if (/negotiat/i.test(message)) return "negotiation_failed";
  return "endpoint_unavailable";
}

/** Negotiate and build the memory runtime for a resolved endpoint. */
export async function createMemoryRuntimeFromEndpoint(
  endpoint: ResolvedAbmindEndpoint,
  home: string,
): Promise<MemoryRuntimeFactoryResult> {
  if (endpoint.mode === "wss") {
    const outboxPath = join(home, "remote", "outbox", `${endpoint.profile.peerId}.json`);
    const client = new AbtarsSignedWssClient(endpoint.profile, outboxPath);
    try {
      await client.negotiate();
      const runtime = createClientRuntime(client);
      assertNegotiatedCapabilities(runtime);
      return { mode: "wss", client, runtime, abmindModule: null };
    } catch (err) {
      await client.close().catch(() => {});
      throw new MemoryEndpointUnavailableError(
        wssFailureCode(err),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const mod = await loadAbmind();
  if (!mod) {
    if (endpoint.source === "explicit") {
      throw new Error("explicit local memory endpoint selected but the abmind package is not installed");
    }
    throw new AbmindModuleMissingError();
  }

  const client = await buildLocalClient(mod, endpoint.socketPath);
  const runtime = createClientRuntime(client);
  assertNegotiatedCapabilities(runtime);
  return { mode: "local", client, runtime, abmindModule: mod };
}

async function buildLocalClient(mod: typeof import("abmind"), socketPath?: string): Promise<AbmindClientLike> {
  if (socketPath) {
    const { AbmindClient, LocalTransport } = mod;
    const client = new AbmindClient(new LocalTransport(socketPath));
    await client.negotiate();
    return client;
  }
  const { getMemoryClient } = mod;
  const mem = await getMemoryClient(true) as import("abmind").AbmindClient;
  return mem;
}

/** A healthy runtime must advertise the core read path after negotiation. */
function assertNegotiatedCapabilities(runtime: AbtarsMemoryRuntime): void {
  if (!runtime.supports("recall")) {
    throw new Error("negotiation did not advertise core memory capabilities");
  }
}

export interface PhaseMemoryDeps {
  resolveEndpoint?: (configDir: string) => ResolvedAbmindEndpoint;
  createRuntime?: (endpoint: ResolvedAbmindEndpoint, home: string) => Promise<MemoryRuntimeFactoryResult>;
}

function recordDegraded(ctx: BootCtx, reason: string, detail?: string): void {
  ctx.client = null;
  ctx.memoryRuntime = createUnavailableRuntime();
  ctx.phaseHealth.set("phaseMemory", { status: "failed", error: detail ? `${reason}: ${detail}` : reason });
  logWarn("boot", `memory: ${reason}. Running without persistent memory.`);
}

export async function phaseMemory(ctx: BootCtx, deps: PhaseMemoryDeps = {}): Promise<PhaseResult> {
  const home = process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");
  const configDir = join(home, "config");

  // A BootCtx may be reused by an in-process restart. Clear prior ownership
  // before disabled, invalid-config, or remote branches can return early.
  ctx.client = null;
  ctx.abmindModule = null;

  // The registry outlives an individual Bridge during an in-process restart.
  // Clear the previous boot's runtime before any branch can skip or fail.
  const { setMemoryRuntime } = await import("../components/transport/tool-registry.js");
  setMemoryRuntime(null);

  if (!ctx.memoryConfig.memoryEnabled) {
    logInfo("main", "Memory disabled");
    ctx.memoryRuntime = createDisabledRuntime();
    ctx.phaseHealth.set("phaseMemory", { status: "skipped", error: "memory disabled" });
    return "skipped";
  }

  const resolveEndpoint = deps.resolveEndpoint ?? resolveAbmindEndpoint;
  let endpoint: ResolvedAbmindEndpoint;
  try {
    endpoint = resolveEndpoint(configDir);
  } catch (err) {
    const code = err instanceof AbmindEndpointConfigError ? err.code : "config_invalid";
    recordDegraded(ctx, `memory endpoint config rejected (${code})`, err instanceof Error ? err.message : undefined);
    return "skipped";
  }

  // ── Local mode: retain abmind package discovery and local transport ─────
  if (endpoint.mode === "local") {
    const legacyAbmindPkgs = [
      join(home, "app", "bundle", "node_modules", "abmind", "package.json"),
      join(home, "app", "node_modules", "abmind", "package.json"),
    ].filter(p => existsSync(p));

    const mod = await loadAbmind();
    ctx.abmindModule = mod;

    if (legacyAbmindPkgs.length > 1) {
      const { logError } = await import("../components/logger.js");
      logError("boot", `FATAL: duplicate bundled abmind at ${legacyAbmindPkgs.map(p => p.replace("/package.json", "")).join(" + ")}. Delete one to prevent dual DB connections. Refusing to start.`);
      process.exit(1);
    }
    if (legacyAbmindPkgs.length === 1 && !mod) {
      const { logError } = await import("../components/logger.js");
      logError("boot", `FATAL: legacy bundled abmind at ${legacyAbmindPkgs[0]!.replace("/package.json", "")} but no global abmind is resolvable. #1243 ships abmind separately — install it first: npm install -g abmind@latest. Refusing to start without memory.`);
      process.exit(1);
    }
    if (!mod) {
      if (endpoint.source === "explicit") {
        recordDegraded(ctx, "explicit local memory endpoint unavailable (abmind package missing)");
        return "skipped";
      }
      ctx.memoryRuntime = createDisabledRuntime();
      ctx.phaseHealth.set("phaseMemory", { status: "skipped", error: "abmind package not installed" });
      return "skipped";
    }
  }

  const createRuntime = deps.createRuntime ?? createMemoryRuntimeFromEndpoint;
  try {
    const result = await createRuntime(endpoint, home);
    ctx.client = result.client;
    ctx.memoryRuntime = result.runtime;
    ctx.abmindModule = result.abmindModule;
    ctx.phaseHealth.set("phaseMemory", { status: "ok", error: undefined });
    logInfo("main", `Memory enabled via ${result.mode} endpoint`);

    const { setMemoryRuntime: wireRuntime } = await import("../components/transport/tool-registry.js");
    wireRuntime(result.runtime);
    logInfo("main", "Memory runtime wired to tool registry");

    return "ran";
  } catch (err) {
    const reason = err instanceof AbmindModuleMissingError
      ? "abmind package not installed"
      : err instanceof MemoryEndpointUnavailableError
        ? `memory endpoint unavailable (${endpoint.mode}, ${err.code})`
        : `memory endpoint unavailable (${endpoint.mode})`;
    recordDegraded(ctx, reason, err instanceof Error ? err.message : undefined);
    return "skipped";
  }
}
