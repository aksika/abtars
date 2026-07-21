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

// ── Real AgentOptions (from pi-agent-core Agent constructor) ──────────────────

export interface AgentState {
  systemPrompt?: string;
  model: unknown;
  messages: readonly AgentMessage[];
  tools?: readonly unknown[];
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface AgentToolResult {
  label: string;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: string;
  isError?: boolean;
}

export interface PiAgentOptions {
  initialState?: Partial<AgentState>;
  streamFn?: StreamFn;
  steeringMode?: "one-at-a-time" | "fifo" | "replace" | "parallel";
  followUpMode?: "one-at-a-time" | "fifo" | "replace" | "parallel";
  toolExecution?: "sequential" | "parallel";
  convertToLlm?: (messages: readonly AgentMessage[]) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  transformContext?: (messages: readonly AgentMessage[], signal?: AbortSignal) => Promise<readonly AgentMessage[]>;
  beforeToolCall?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => BeforeToolCallResult | undefined;
  afterToolCall?: (result: unknown) => unknown;
  prepareNextTurnWithContext?: (context: {
    message?: AssistantMessage;
    toolResults?: readonly { toolCallId: string; toolName: string; result?: string; isError?: boolean }[];
    context?: unknown;
    newMessages?: readonly AgentMessage[];
  }) => unknown;
}

/** Real AgentLoopContext passed to beforeToolCall/afterToolCall hooks. */
export interface PiAgentToolCallContext {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

// ── Real Agent contract ───────────────────────────────────────────────────────

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

export type PiAgentListener = (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void;

// ── Real AgentEvent union (from pi-agent-core) ────────────────────────────────

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: readonly AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage; assistantMessageEvent: unknown }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: string; isError?: boolean };

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

// ── Real AssistantMessageEventStream (concrete class with .result()) ──────────

export interface AssistantMessageEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
  toolCall?: ToolCall;
  message?: AssistantMessage;
  reason?: string;
  error?: string;
}

export interface AssistantMessageEventStream {
  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
  result(): Promise<AssistantMessage>;
}

export type SimpleStreamOptions = Record<string, unknown>;

export type StreamFn = (
  model: unknown,
  context: unknown,
  options: SimpleStreamOptions,
) => AssistantMessageEventStream;

// ── Pi module contract ────────────────────────────────────────────────────────

export interface PiAgentCoreModule {
  Agent: new (options: PiAgentOptions) => PiAgent;
}

// ── #1444: instruction messages ────────────────────────────────────────────────

export interface AbtarsInstructionAgentMessage extends AgentMessage {
  role: "abtars_instruction";
  leaseId: string;
  instructionIds: readonly string[];
  executionId: string;
  kind: "steer" | "followUp";
}

// ── #1446: current-turn marker ─────────────────────────────────────────────────

export interface AbtarsCurrentTurnMessage extends AgentMessage {
  role: "abtars_current_turn";
  executionId: string;
  sessionId: string;
  durableMessageId?: number;
  timestamp: number;
  imageContent?: Array<{ mime: string; base64: string }>;
}

// ── #1446: context projection source ───────────────────────────────────────────

export type PiContextProjectionSource =
  | {
      mode: "durable";
      sessionKey: string;
      beforeMessageId: number;
      maxContext: number;
    }
  | {
      mode: "ephemeral";
      sessionKey: string;
    };

export interface PiExecutionContextSeed {
  source: PiContextProjectionSource;
  executionId: string;
  currentTurn: AbtarsCurrentTurnMessage;
  volatileBlocks: readonly { kind: string; content: string }[];
}

// ── #1446: tool execution context ──────────────────────────────────────────────

export interface PiToolExecutionContext {
  executionId: string;
  userId: string;
  signal?: AbortSignal;
  safety: unknown;
  onToolStart?: (name: string) => void;
  onToolSuccess?: () => void;
  /** Wrap a JSON schema object as a Pi-compatible TypeScript schema (Type.Unsafe). */
  createUnsafeSchema?: (schema: Record<string, unknown>) => Record<string, unknown>;
}

// ── #1446: safety controller types ─────────────────────────────────────────────

export type ToolDecision =
  | { decision: "execute" }
  | { decision: "error"; reason: string }
  | { decision: "skip" };

export type TurnDecision =
  | { decision: "continue" }
  | { decision: "stop"; reason: string }
  | { decision: "pause" };

export interface AgentLoopTurnUpdate {
  model?: unknown;
  context?: unknown;
}

export interface PrepareNextTurnContext {
  roundsUsed: number;
  maxRounds: number;
  incident: unknown;
  candidateKey: string;
}

/** Wrapper for the real Pi prepareNextTurnWithContext callback argument. */
export interface RealPrepareNextTurnContext {
  message?: AssistantMessage;
  toolResults?: readonly { toolCallId: string; toolName: string; result?: string; isError?: boolean }[];
  context?: unknown;
  newMessages?: readonly AgentMessage[];
}

// ── #1446: AgentTool shape ────────────────────────────────────────────────────

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (event: unknown) => void,
  ): Promise<AgentToolResult>;
  executionMode?: "sequential" | "parallel";
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

// ── Converters ─────────────────────────────────────────────────────────────────

export function convertInstructionToLlm(message: AgentMessage): AgentMessage {
  if (message.role !== "abtars_instruction") return message;
  const inst = message as AbtarsInstructionAgentMessage;
  return {
    role: "user",
    content: `${inst.content}\n[timestamp: ${inst.timestamp ?? Date.now()}]`,
    timestamp: inst.timestamp,
  };
}

export function convertCurrentTurnToLlm(message: AgentMessage): AgentMessage {
  if (message.role !== "abtars_current_turn") return message;
  const turn = message as AbtarsCurrentTurnMessage;
  return {
    role: "user",
    content: turn.content,
    timestamp: turn.timestamp,
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

export function createCurrentTurnMessage(
  content: string,
  executionId: string,
  sessionId: string,
  durableMessageId?: number,
): AbtarsCurrentTurnMessage {
  return {
    role: "abtars_current_turn",
    executionId,
    sessionId,
    durableMessageId,
    content,
    timestamp: Date.now(),
  };
}

export const PI_AGENT_CORE_CONFIG = {
  steeringMode: "one-at-a-time" as const,
  followUpMode: "one-at-a-time" as const,
  toolExecution: "sequential" as const,
};
