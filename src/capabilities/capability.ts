import { getEnv } from "../components/env-schema.js";
import { logError } from "../components/logger.js";
import { logAndSwallow } from "../components/log-and-swallow.js";

const TAG = "capabilities";
/**
 * Capability system — typed registration API for bridge subsystems.
 *
 * Each capability is a self-contained module that registers commands,
 * heartbeat tasks, and services via a constrained CapabilityApi.
 * The bridge wires registered items into the appropriate subsystems.
 */

import type { HeartbeatTask } from "../types/index.js";
import type { Config } from "../types/config.js";
import type { IMemorySystem } from "abmind";
import type { IKiroTransport } from "../components/transport/kiro-transport.js";
import type { SubagentRuntime } from "../components/subagent-runtime.js";
import type { CommandContext } from "../components/commands/types.js";

/** Handler for a slash command registered by a capability. */
export type CapabilityCommandHandler = (text: string, ctx: CommandContext) => Promise<boolean>;

/** Service with start/stop lifecycle. */
export interface CapabilityService {
  start(): Promise<void>;
  stop(): void;
}

/** Factory that creates a service instance. */
export type CapabilityServiceFactory = () => Promise<CapabilityService>;

/** Read-only API given to each capability during registration. */
export interface CapabilityApi {
  readonly config: Config;
  readonly memory: IMemorySystem | null;
  readonly transport: IKiroTransport;
  readonly runtime: SubagentRuntime;
  readonly sessionManager: { getActiveSessionId(userId: string, platform: string): string };
  readonly sendSystemMessage?: (prompt: string) => Promise<void>;
  registerCommand(name: string, handler: CapabilityCommandHandler): void;
  registerHeartbeatTask(task: HeartbeatTask): void;
  registerService(name: string, factory: CapabilityServiceFactory): void;
}

/** A capability module exports a register function with this signature. */
export type CapabilityRegisterFn = (api: CapabilityApi) => void;

/** Collected registrations from all capabilities. */
export interface CapabilityRegistry {
  commands: Map<string, CapabilityCommandHandler>;
  heartbeatTasks: HeartbeatTask[];
  services: Map<string, CapabilityServiceFactory>;
}

/** Create an empty registry. */
export function createCapabilityRegistry(): CapabilityRegistry {
  return {
    commands: new Map(),
    heartbeatTasks: [],
    services: new Map(),
  };
}

/** Create a CapabilityApi that collects registrations into the given registry. */
export function createCapabilityApi(
  registry: CapabilityRegistry,
  config: Config,
  memory: IMemorySystem | null,
  transport: IKiroTransport,
  runtime: SubagentRuntime,
  sessionManager?: { getActiveSessionId(userId: string, platform: string): string },
  sendSystemMessage?: (prompt: string) => Promise<void>,
): CapabilityApi {
  return {
    config,
    memory,
    transport,
    runtime,
    sessionManager: sessionManager ?? { getActiveSessionId: () => "master:telegram" },
    sendSystemMessage,
    registerCommand(name, handler) { registry.commands.set(name, handler); },
    registerHeartbeatTask(task) { registry.heartbeatTasks.push(task); },
    registerService(name, factory) { registry.services.set(name, factory); },
  };
}

/** Discover and register capabilities with capability.json manifests. */
export async function discoverCapabilities(
  registry: CapabilityRegistry,
  config: Config,
  memory: IMemorySystem | null,
  transport: IKiroTransport,
  runtime: SubagentRuntime,
  capabilitiesDir: string,
): Promise<string[]> {
  const { readdirSync, existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const disabled = new Set(
    getEnv().disabledCapabilities.split(",").map(s => s.trim()).filter(Boolean),
  );

  const loaded: string[] = [];
  let dirs: string[];
  try { dirs = readdirSync(capabilitiesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch (err) { logAndSwallow(TAG, "readdirSync capabilities", err); return loaded; }

  for (const dir of dirs) {
    const manifestPath = join(capabilitiesDir, dir, "capability.json");
    if (!existsSync(manifestPath)) continue; // no manifest = core capability, skip

    let manifest: { name: string; description?: string };
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf-8")); }
    catch (err) { logAndSwallow(TAG, "JSON.parse capability manifest", err); continue; }

    if (disabled.has(manifest.name)) continue;

    try {
      const mod = await import(join(capabilitiesDir, dir, "index.js"));
      const api = createCapabilityApi(registry, config, memory, transport, runtime);
      mod.register(api);
      loaded.push(manifest.name);
    } catch (err) { logError("capabilities", `Failed to load capability "${manifest.name}": ${err instanceof Error ? err.message : String(err)}`); }
  }

  return loaded;
}
