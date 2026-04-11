/**
 * Capability system — typed registration API for bridge subsystems.
 *
 * Each capability is a self-contained module that registers commands,
 * heartbeat tasks, and services via a constrained CapabilityApi.
 * The bridge wires registered items into the appropriate subsystems.
 */

import type { HeartbeatTask } from "../types/memory.js";
import type { Config } from "../types/config.js";
import type { IMemorySystem } from "@agentbridge/memory/imemory-system.js";
import type { IKiroTransport } from "../components/transport/kiro-transport.js";
import type { CommandContext } from "../components/command-handlers.js";

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
): CapabilityApi {
  return {
    config,
    memory,
    transport,
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
  capabilitiesDir: string,
): Promise<string[]> {
  const { readdirSync, existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const disabled = new Set(
    (process.env["DISABLED_CAPABILITIES"] ?? "").split(",").map(s => s.trim()).filter(Boolean),
  );

  const loaded: string[] = [];
  let dirs: string[];
  try { dirs = readdirSync(capabilitiesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return loaded; }

  for (const dir of dirs) {
    const manifestPath = join(capabilitiesDir, dir, "capability.json");
    if (!existsSync(manifestPath)) continue; // no manifest = core capability, skip

    let manifest: { name: string; description?: string };
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf-8")); }
    catch { continue; }

    if (disabled.has(manifest.name)) continue;

    try {
      const mod = await import(join(capabilitiesDir, dir, "index.js"));
      const api = createCapabilityApi(registry, config, memory, transport);
      mod.register(api);
      loaded.push(manifest.name);
    } catch { /* skip broken capabilities */ }
  }

  return loaded;
}
