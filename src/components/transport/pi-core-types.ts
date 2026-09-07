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
  Message,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AbtarsContentPart,
  AbtarsCurrentTurnMessage,
  AbtarsImagePart,
  AbtarsInstructionAgentMessage,
} from "./pi-port.js";

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

// ── #1444/#1446 product messages: owned by ./pi-port.js ──────────────────────
// AbtarsInstructionAgentMessage, AbtarsCurrentTurnMessage, and the content
// model live in the Pi-free port module; this integration area imports them
// for the augmentation declaration, factories, and converters below.

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    abtars_instruction: AbtarsInstructionAgentMessage;
    abtars_current_turn: AbtarsCurrentTurnMessage;
  }
}

export type AbtarsAgentMessage = AgentMessage | AbtarsInstructionAgentMessage | AbtarsCurrentTurnMessage;

// Product vocabulary re-exported for compatibility: product code should
// import these from ./pi-port.js directly. The port module itself stays
// Pi-free; this barrel only forwards product types, never Pi types.
export type {
  AbtarsContentPart,
  AbtarsImagePart,
  AbtarsInstructionAgentMessage,
  AbtarsCurrentTurnMessage,
  PiContextProjectionSource,
  PiExecutionContextSeed,
  PiToolExecutionContext,
  ToolDecision,
  TurnDecision,
  PortTurnIdentity,
  PortModelPolicy,
  PortToolDescriptor,
  PortTerminalOutcome,
  PortEventKind,
} from "./pi-port.js";

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
  if (turn.images && turn.images.length > 0) {
    const text = typeof turn.content === "string" ? turn.content : "";
    return {
      role: "user",
      content: [
        { type: "text" as const, text },
        ...turn.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
      ],
      timestamp: turn.timestamp,
    } satisfies UserMessage;
  }
  return {
    role: "user",
    content: typeof turn.content === "string" ? turn.content : turn.content.map((part) =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "image" as const, data: part.data, mimeType: part.mimeType },
    ),
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
  content: string | AbtarsContentPart[],
  executionId: string,
  sessionId: string,
  durableMessageId?: number,
  images?: AbtarsImagePart[],
): AbtarsCurrentTurnMessage {
  return {
    role: "abtars_current_turn",
    executionId,
    sessionId,
    durableMessageId,
    content,
    timestamp: Date.now(),
    images,
  };
}

export const PI_AGENT_CORE_CONFIG = {
  steeringMode: "one-at-a-time" as const,
  followUpMode: "one-at-a-time" as const,
  toolExecution: "sequential" as const,
};
