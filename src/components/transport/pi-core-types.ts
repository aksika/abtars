import { logInfo } from "../logger.js";
import type { Agent as PublicPiAgent, AgentMessage as PublicPiAgentMessage } from "@earendil-works/pi-agent-core";

/**
 * pi-core-types.ts — the remaining Pi agent-core contract surface (#1940).
 * Pi's AgentSession owns the agent loop; abtars keeps the tool types, the
 * message type its safety scrub operates on, and the agent-core contract
 * probe used by `pi-runtime-contract.ts`.
 */

const TAG = "pi-core-types";

export class PiCoreContractError extends Error {
  readonly installationVersion?: string;
  readonly missingCapability?: string;
  constructor(message: string, options?: { installationVersion?: string; missingCapability?: string; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "PiCoreContractError";
    this.installationVersion = options?.installationVersion;
    this.missingCapability = options?.missingCapability;
  }
}

export type PiAgent = PublicPiAgent;
export type AbtarsAgentMessage = PublicPiAgentMessage;
export type AgentTool = import("@earendil-works/pi-agent-core").AgentTool;
export type AgentToolResult<T = unknown> = import("@earendil-works/pi-agent-core").AgentToolResult<T>;

export interface PiAgentCoreModule {
  Agent: new (...args: never[]) => PiAgent;
}

// ── Validation ─────────────────────────────────────────────────────────────────

const REQUIRED_METHODS: readonly (keyof PiAgent)[] = [
  "subscribe", "prompt", "steer", "followUp",
  "clearAllQueues", "abort", "waitForIdle",
];

const REQUIRED_MODULE_EXPORTS: readonly (keyof PiAgentCoreModule)[] = ["Agent"];

export function validatePiAgentCoreModule(
  mod: unknown,
  version?: string,
): asserts mod is PiAgentCoreModule {
  if (!mod || typeof mod !== "object") {
    throw new PiCoreContractError("Loaded pi-agent-core module is not an object", { installationVersion: version });
  }
  for (const key of REQUIRED_MODULE_EXPORTS) {
    if (!(key in (mod as Record<string, unknown>))) {
      throw new PiCoreContractError(`pi-agent-core missing required export: ${key}`, {
        installationVersion: version,
        missingCapability: key,
      });
    }
  }
  const maybeModule = mod as Record<string, unknown>;

  if (typeof maybeModule.Agent !== "function" && typeof maybeModule.Agent !== "object") {
    throw new PiCoreContractError("pi-agent-core: Agent is not a constructor", {
      installationVersion: version,
      missingCapability: "Agent",
    });
  }

  const agentProto = typeof maybeModule.Agent === "function"
    ? maybeModule.Agent.prototype
    : maybeModule.Agent;
  if (!agentProto || typeof agentProto !== "object") {
    throw new PiCoreContractError("pi-agent-core: Agent has no prototype", {
      installationVersion: version,
      missingCapability: "Agent",
    });
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof (agentProto as Record<string, unknown>)[method] !== "function") {
      throw new PiCoreContractError(`pi-agent-core Agent missing method: ${method}`, {
        installationVersion: version,
        missingCapability: method,
      });
    }
  }

  logInfo(TAG, `Validated pi-agent-core contract (${version ?? "unknown"})`);
}
