import { logInfo } from "../logger.js";
import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import type { PiModuleSpecifier, PiInstallation } from "../pi-installation.js";
import type {
  Agent as PublicPiAgent,
  AgentEvent as PublicPiAgentEvent,
  AgentMessage as PublicPiAgentMessage,
  AgentOptions as PublicPiAgentOptions,
  AgentLoopTurnUpdate as PublicAgentLoopTurnUpdate,
  BeforeToolCallContext as PublicBeforeToolCallContext,
  BeforeToolCallResult as PublicBeforeToolCallResult,
  PrepareNextTurnContext as PublicPrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage as PublicAssistantMessage,
  AssistantMessageEvent as PublicAssistantMessageEvent,
  AssistantMessageEventStream as PublicAssistantMessageEventStream,
  Api,
  ImageContent,
  Message,
  Model,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";

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

// These aliases deliberately come from the public Pi packages. The runtime
// loader remains installation-scoped, but the adapter must compile against the
// exact Agent/Message/StreamFn contracts it will receive.
export type AgentState = import("@earendil-works/pi-agent-core").AgentState;
export type AgentContext = import("@earendil-works/pi-agent-core").AgentContext;
export type BeforeToolCallResult = PublicBeforeToolCallResult;
export type BeforeToolCallContext = PublicBeforeToolCallContext;
export type AgentToolResult<T = unknown> = import("@earendil-works/pi-agent-core").AgentToolResult<T>;
export type PiAgentOptions = PublicPiAgentOptions;
export type PiAgent = PublicPiAgent;
export type PiAgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
export type AgentEvent = PublicPiAgentEvent;
export type AgentMessage = PublicPiAgentMessage;
export type AssistantMessage = PublicAssistantMessage;
export type AssistantMessageEvent = PublicAssistantMessageEvent;
export type AssistantMessageEventStream = PublicAssistantMessageEventStream;
export type SimpleStreamOptions = import("@earendil-works/pi-ai").SimpleStreamOptions;
export type StreamFn = import("@earendil-works/pi-agent-core").StreamFn;
export type AgentLoopTurnUpdate = PublicAgentLoopTurnUpdate;
export type PrepareNextTurnContext = PublicPrepareNextTurnContext;
export type Usage = PublicAssistantMessage["usage"];
export type ModelApi = Model<Api>;

// ── Pi module contract ────────────────────────────────────────────────────────

export interface PiAgentCoreModule {
  Agent: new (options?: PiAgentOptions) => PiAgent;
}

// ── #1444: instruction messages ────────────────────────────────────────────────

export interface AbtarsInstructionAgentMessage {
  role: "abtars_instruction";
  content: string;
  timestamp?: number;
  leaseId: string;
  instructionIds: readonly string[];
  executionId: string;
  kind: "steer" | "followUp";
}

// ── #1446: current-turn marker ─────────────────────────────────────────────────

export interface AbtarsCurrentTurnMessage {
  role: "abtars_current_turn";
  content: string | Array<TextContent | ImageContent>;
  executionId: string;
  sessionId: string;
  durableMessageId?: number;
  timestamp: number;
  imageContent?: Array<{ mime: string; base64: string }>;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    abtars_instruction: AbtarsInstructionAgentMessage;
    abtars_current_turn: AbtarsCurrentTurnMessage;
  }
}

export type AbtarsAgentMessage = AgentMessage | AbtarsInstructionAgentMessage | AbtarsCurrentTurnMessage;

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

export interface SafetyPrepareNextTurnContext {
  roundsUsed: number;
  maxRounds: number;
  incident: unknown;
  candidateKey: string;
  context?: AgentContext;
  modelForCandidate?: (candidateKey: string) => ModelApi | undefined;
}

/** Wrapper for the real Pi prepareNextTurnWithContext callback argument. */
export type AgentTool = import("@earendil-works/pi-agent-core").AgentTool;

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
  // The installed 0.80.7 executor stops its sequential loop after the active
  // call observes abort and never emits terminal results for later calls. Do
  // not report readiness until a public Pi release repairs that contract.
  if (version === "0.80.7") {
    throw new PiCoreContractError(
      "pi-agent-core 0.80.7 is not ready for #1446: sequential cancellation omits terminal results for unstarted calls",
      { installationVersion: version, missingCapability: "sequential-batch-cancellation" },
    );
  }
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

export function convertInstructionToLlm(message: AbtarsAgentMessage): Message {
  if (message.role !== "abtars_instruction") return message as Message;
  const inst = message as AbtarsInstructionAgentMessage;
  return {
    role: "user",
    content: inst.content,
    timestamp: inst.timestamp ?? Date.now(),
  } satisfies UserMessage;
}

export function convertCurrentTurnToLlm(message: AbtarsAgentMessage): Message {
  if (message.role !== "abtars_current_turn") return message as Message;
  const turn = message as AbtarsCurrentTurnMessage;
  if (turn.imageContent && turn.imageContent.length > 0) {
    const text = typeof turn.content === "string" ? turn.content : "";
    return {
      role: "user",
      content: [
        { type: "text" as const, text },
        ...turn.imageContent.map((img) => ({ type: "image" as const, data: img.base64, mimeType: img.mime })),
      ],
      timestamp: turn.timestamp,
    } satisfies UserMessage;
  }
  return {
    role: "user",
    content: typeof turn.content === "string" ? turn.content : turn.content,
    timestamp: turn.timestamp,
  } satisfies UserMessage;
}

export function convertMessagesToLlm(messages: readonly AbtarsAgentMessage[]): Message[] {
  return messages.flatMap((message) => {
    if (message.role === "abtars_instruction") return [convertInstructionToLlm(message)];
    if (message.role === "abtars_current_turn") return [convertCurrentTurnToLlm(message)];
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      return [message as Message];
    }
    return [];
  });
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
  content: string | Array<TextContent | ImageContent>,
  executionId: string,
  sessionId: string,
  durableMessageId?: number,
  imageContent?: Array<{ mime: string; base64: string }>,
): AbtarsCurrentTurnMessage {
  return {
    role: "abtars_current_turn",
    executionId,
    sessionId,
    durableMessageId,
    content,
    timestamp: Date.now(),
    imageContent,
  };
}

export const PI_AGENT_CORE_CONFIG = {
  steeringMode: "one-at-a-time" as const,
  followUpMode: "one-at-a-time" as const,
  toolExecution: "sequential" as const,
};
