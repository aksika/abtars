/**
 * phase-memory — boot composition of the memory layer (#1508, #1706).
 *
 * One shared attempt closure serves both initial boot and every late retry:
 *   1. re-resolve the abtars-owned endpoint descriptor (~/.abtars/config/abmind.json)
 *   2. local mode → enforce package-layout FATALs (duplicate/legacy bundle)
 *   3. negotiate via createMemoryRuntimeFromEndpoint (local or signed WSS)
 *   4. typed failures map to a bounded reason code
 *
 * On immediate success the negotiated runtime is published through the same
 * synchronous publication function used by retries. On any recoverable
 * failure — invalid config, missing package, unreachable endpoint — a stable
 * re-composable facade stays installed in ctx.memoryRuntime, an idle
 * supervisor is stored on ctx.memoryRecomposition (started post-graph by
 * startBridge), and a bounded MemoryCompositionPendingError is thrown so the
 * optional `memory` boot node reports failed until late composition lands.
 *
 * Operator-disabled memory remains terminal: disabled runtime, no supervisor.
 *
 * Doctor compatibility: the endpoint factory and its error classes stay
 * exported here unchanged.
 */

import { logInfo, logWarn } from "../components/logger.js";
import { logAndSwallow } from "../components/log-and-swallow.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { loadAbmind } from "../utils/abmind-lazy.js";
import {
  createDisabledRuntime,
  createClientRuntime,
  type MemoryCompositionDiagnostics,
  type MemoryCompositionFailureCode,
} from "../components/memory-runtime.js";
import { resolveAbmindEndpoint, AbmindEndpointConfigError, type ResolvedAbmindEndpoint } from "../components/abmind-endpoint-config.js";
import type { AbmindClientLike } from "../components/abmind-client-contract.js";
import { AbtarsSignedWssClient } from "../components/abmind-signed-wss-client.js";
import {
  RecomposableMemoryRuntime,
  MemoryRecompositionSupervisor,
  type CompositionAttemptResult,
} from "../components/memory-recomposition.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Boot-independent composition result owned by the component layer;
 *  re-exported under the historical name for doctor compatibility. */
export type MemoryRuntimeFactoryResult = CompositionAttemptResult;

/** Marker error: default local mode with no resolvable abmind package. */
export class AbmindModuleMissingError extends Error {
  constructor() {
    super("abmind package is not installed");
    this.name = "AbmindModuleMissingError";
  }
}

/** Thrown on recoverable initial composition failure so the optional
 *  `memory` boot node records failed while retries continue in background. */
export class MemoryCompositionPendingError extends Error {
  readonly code: MemoryCompositionFailureCode;

  constructor(code: MemoryCompositionFailureCode) {
    super(`memory composition pending (${code})`);
    this.name = "MemoryCompositionPendingError";
    this.code = code;
  }
}

/** Bounded reason codes exposed to boot/status diagnostics for remote endpoints. */
export type MemoryEndpointFailureCode =
  | "endpoint_unavailable"
  | "pin_mismatch"
  | "authentication_failed"
  | "negotiation_failed"
  | "policy_rejected"
  | "retry_exhausted";

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
  if (/connection failed|econnrefused|closed before open|timed out|route not ready|outcome unknown/i.test(message)) return "endpoint_unavailable";
  if (/negoti/i.test(message)) return "negotiation_failed";
  if (/policy|grant/i.test(message)) return "policy_rejected";
  if (/retry|budget|exhaust/i.test(message)) return "retry_exhausted";
  return "endpoint_unavailable";
}

/** Map any composition failure to the closed bounded code union (#1706).
 *  Typed errors first; bounded message matching only as fallback. */
export function classifyCompositionFailure(err: unknown): MemoryCompositionFailureCode {
  if (err instanceof AbmindEndpointConfigError) return "config_invalid";
  if (err instanceof AbmindModuleMissingError) return "package_missing";
  if (err instanceof MemoryEndpointUnavailableError) return err.code;
  const message = err instanceof Error ? err.message : String(err);
  if (/abmind package is not installed/.test(message)) return "package_missing";
  return wssFailureCode(err);
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
      await client.close().catch(closeErr => logAndSwallow("memory", "close WSS client after failed negotiation", closeErr));
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
    try {
      await client.negotiate();
      return client;
    } catch (err) {
      // The client owns a Unix socket before negotiation succeeds — close it
      // so a failed negotiation cannot leak socket/reconnect resources.
      // Reused by `abtars doctor` through createMemoryRuntimeFromEndpoint.
      await client.close().catch(closeErr => logAndSwallow("memory", "close local client after failed negotiation", closeErr));
      throw err;
    }
  }
  const { getMemoryClient } = mod;
  const mem = await getMemoryClient(true) as import("abmind").AbmindClient;
  return mem;
}

/** A healthy runtime must advertise the core read path after negotiation. */
function assertNegotiatedCapabilities(runtime: import("../components/memory-runtime.js").AbtarsMemoryRuntime): void {
  if (!runtime.supports("recall")) {
    throw new Error("negotiation did not advertise core memory capabilities");
  }
}

export interface PhaseMemoryDeps {
  resolveEndpoint?: (configDir: string) => ResolvedAbmindEndpoint;
  createRuntime?: (endpoint: ResolvedAbmindEndpoint, home: string) => Promise<MemoryRuntimeFactoryResult>;
  /** Injectable retry scheduler for deterministic tests; production uses
   *  the supervisor's unref timeout chain. */
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

function updateLiveHealth(ctx: BootCtx, snap: MemoryCompositionDiagnostics): void {
  if (snap.state === "upgraded") {
    ctx.phaseHealth.set("memory", { status: "ok" });
    return;
  }
  const detail = snap.lastFailure !== undefined
    ? `${snap.state} (${snap.attempts}, ${snap.lastFailure})`
    : `${snap.state} (${snap.attempts})`;
  ctx.phaseHealth.set("memory", { status: "failed", error: detail });
}

export async function phaseMemory(ctx: BootCtx, deps: PhaseMemoryDeps = {}): Promise<PhaseResult> {
  const home = process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");
  const configDir = join(home, "config");

  // In-process generation reset: drain any stale supervisor before rebuilding
  // ownership, so two generations can never retry concurrently.
  await ctx.memoryRecomposition?.cancel();
  ctx.memoryRecomposition = null;
  ctx.client = null;
  ctx.abmindModule = null;

  if (!ctx.memoryConfig.memoryEnabled) {
    logInfo("main", "Memory disabled");
    ctx.memoryRuntime = createDisabledRuntime();
    ctx.phaseHealth.set("memory", { status: "skipped", error: "memory disabled" });
    return "skipped";
  }

  const resolveEndpoint = deps.resolveEndpoint ?? resolveAbmindEndpoint;
  const createRuntime = deps.createRuntime ?? createMemoryRuntimeFromEndpoint;

  // Stable facade installed before the first attempt: consumers that capture
  // it during boot always hold the reference that later upgrades in place.
  const controller = new RecomposableMemoryRuntime();
  ctx.memoryRuntime = controller.runtime;

  // Shared composition attempt — initial boot and every retry execute exactly
  // this: fresh endpoint resolution, local package-layout FATALs, negotiate.
  const attempt = async (): Promise<CompositionAttemptResult> => {
    const endpoint = resolveEndpoint(configDir);

    if (endpoint.mode === "local") {
      const legacyAbmindPkgs = [
        join(home, "app", "bundle", "node_modules", "abmind", "package.json"),
        join(home, "app", "node_modules", "abmind", "package.json"),
      ].filter(p => existsSync(p));

      const mod = await loadAbmind();

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
      // A missing global package falls through to the factory, which throws
      // the typed missing-package errors for implicit and explicit sources.
    }

    return createRuntime(endpoint, home);
  };

  // Synchronous publication, identical for initial success and late retry:
  // assign ctx ownership, swap the facade delegate, flip live health.
  const publish = (result: CompositionAttemptResult): void => {
    ctx.client = result.client;
    ctx.abmindModule = result.abmindModule;
    controller.upgrade(result.runtime);
    logInfo("main", `Memory enabled via ${result.mode} endpoint`);
    ctx.phaseHealth.set("memory", { status: "ok" });
  };

  try {
    const result = await attempt();
    publish(result);
    return "ran";
  } catch (err) {
    const code = classifyCompositionFailure(err);
    controller.setDiagnostics({ state: "idle", attempts: 1, lastAttemptAt: Date.now(), lastFailure: code });
    const onDiagnostics = (snap: MemoryCompositionDiagnostics): void => {
      controller.setDiagnostics(snap);
      updateLiveHealth(ctx, snap);
    };
    ctx.memoryRecomposition = new MemoryRecompositionSupervisor({
      attempt,
      classifyFailure: classifyCompositionFailure,
      publish,
      dispose: (result) => result.client.close(),
      onDiagnostics,
      initial: { attempts: 1, lastFailure: code },
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
    });
    logWarn("boot", `memory: composition deferred (${code}). Will keep retrying without blocking boot.`);
    updateLiveHealth(ctx, { state: "idle", attempts: 1, lastFailure: code });
    throw new MemoryCompositionPendingError(code);
  }
}
