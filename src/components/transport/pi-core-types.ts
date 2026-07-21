import { logInfo } from "../logger.js";
import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import type { PiModuleSpecifier, PiInstallation } from "../pi-installation.js";

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

export type ExecutionRoute = import("../transport-config.js").ExecutionRoute;

export interface PiAgentOptions {
  systemPrompt?: string;
  model: unknown;
  streamFn: StreamFn;
  tools?: readonly unknown[];
  steeringMode?: "one-at-a-time" | "fifo" | "replace" | "parallel";
  followUpMode?: "one-at-a-time" | "fifo" | "replace" | "parallel";
  toolExecution?: "sequential" | "parallel";
  convertToLlm?: (message: AgentMessage) => AgentMessage;
  transformContext?: (context: unknown) => unknown;
  beforeToolCall?: (toolCall: unknown) => unknown;
  afterToolCall?: (result: unknown) => unknown;
  prepareNextTurnWithContext?: (context: unknown) => unknown;
}

export interface PiAgent {
  readonly isRunning: boolean;
  subscribe(listener: PiAgentListener): () => void;
  prompt(message: AgentMessage | readonly AgentMessage[]): Promise<void>;
  steer(message: AgentMessage): void;
  followUp(message: AgentMessage): void;
  clearAllQueues(): void;
  abort(): void;
  waitForIdle(): Promise<void>;
}

export type PiAgentListener = (event: AgentEvent) => void;

export type AgentEvent =
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_start"; contentIndex: number; toolCall: ToolCall }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "agent_end"; reason: string }
  | { type: "error"; error: AssistantMessage };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentMessage {
  role: string;
  content: string;
  timestamp?: number;
}

export interface AssistantMessage extends AgentMessage {
  role: "assistant";
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export type SimpleStreamOptions = Record<string, unknown>;

export type AssistantMessageEventStream = AsyncIterable<AssistantMessage & { type: string }>;

export type StreamFn = (
  model: unknown,
  context: unknown,
  options: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface PiAgentCoreModule {
  Agent: new (options: PiAgentOptions) => PiAgent;
}

export interface AbtarsInstructionAgentMessage extends AgentMessage {
  role: "abtars_instruction";
  leaseId: string;
  instructionIds: readonly string[];
  executionId: string;
  kind: "steer" | "followUp";
}

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

export interface LoadedPiAgentCore {
  module: PiAgentCoreModule;
  installation: PiInstallation;
}

export async function loadAndValidatePiAgentCore(): Promise<LoadedPiAgentCore> {
  const result = resolvePiInstallation();
  if (result.state !== "compatible") {
    throw new PiCoreContractError(
      `Pi installation not available: ${result.state}`,
      { missingCapability: "PiInstallation" },
    );
  }
  const spec: PiModuleSpecifier = { package: "@earendil-works/pi-agent-core" };
  let mod: unknown;
  try {
    mod = await loadPiModule(result.installation, spec);
  } catch (err) {
    throw new PiCoreContractError(
      `Failed to load pi-agent-core: ${err instanceof Error ? err.message : String(err)}`,
      { installationVersion: result.installation.version, cause: err, missingCapability: "load" },
    );
  }
  validatePiAgentCoreModule(mod, result.installation.version);
  return { module: mod as PiAgentCoreModule, installation: result.installation };
}

export function convertInstructionToLlm(message: AgentMessage): AgentMessage {
  if (message.role !== "abtars_instruction") return message;
  const inst = message as AbtarsInstructionAgentMessage;
  return {
    role: "user",
    content: `${inst.content}\n[timestamp: ${inst.timestamp ?? Date.now()}]`,
    timestamp: inst.timestamp,
  };
}

export function createInstructionMessage(
  content: string,
  leaseId: string,
  instructionIds: readonly string[],
  executionId: string,
  kind: "steer" | "followUp",
): AbtarsInstructionAgentMessage {
  return {
    role: "abtars_instruction",
    leaseId,
    instructionIds,
    executionId,
    kind,
    content,
    timestamp: Date.now(),
  };
}

export const PI_AGENT_CORE_CONFIG = {
  steeringMode: "one-at-a-time" as const,
  followUpMode: "one-at-a-time" as const,
  toolExecution: "sequential" as const,
};
