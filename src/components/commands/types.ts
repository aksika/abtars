export type { Platform } from "../../types/platform.js";
import type { PipelineDeps } from "../message-pipeline.js";
import type { RunningJob } from "../tasks/task-queue.js";

export type Reply = (text: string, opts?: { parseMode?: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }) => Promise<number | string | undefined>;

export interface CommandContext {
  sessionKey: string;
  chatId: number;
  userId: string;
  platform: import("../../types/platform.js").Platform;
  reply: Reply;
  editReply?: (messageId: number | string, text: string) => Promise<void>;
  transport: PipelineDeps["transport"];
  config: PipelineDeps["config"];
  startedAt: PipelineDeps["startedAt"];
  memoryRuntime: PipelineDeps["memoryRuntime"];
  memoryConfig: PipelineDeps["memoryConfig"];
  nlmConfig: PipelineDeps["nlmConfig"];
  idleSave: PipelineDeps["idleSave"];
  sessionManager: PipelineDeps["sessionManager"];
  updateCtxStart: PipelineDeps["updateCtxStart"];
  cronCurrentJob?: RunningJob | null;
  /** #1539: every lane currently executing (manual + scheduled). */
  cronCurrentJobs?: RunningJob[];
  /** #1539: per-lane durable pending/current view. */
  cronQueueView?: () => Array<{
    lane: string;
    current: (RunningJob & {
      phase?: string;
      lastProgressAt?: number;
      deadlineAt?: number;
      terminalRequest?: { kind: "cancelled" | "deadline_exceeded"; requestedAt: number; reason: string };
      cardId?: number;
      sessionId?: string;
      executionId?: string;
    }) | null;
    pending: Array<{ entryId: string; runId?: string; manual?: boolean; priority?: string }>;
  }>;
  enqueueCron?: PipelineDeps["enqueueCron"];
  requestShutdown?: PipelineDeps["requestShutdown"];
  sleepProgress?: PipelineDeps["sleepProgress"];
  startSleep?: PipelineDeps["startSleep"];
  loadedCapabilities?: PipelineDeps["loadedCapabilities"];
  selfHealerTask?: { enabled: boolean; resetCircuitBreaker?: () => void; pausedRules?: () => number } | null;
  hailMary?: PipelineDeps["hailMary"];
  /** #1468: live emergency state for status/help rendering. */
  emergencyExecution?: PipelineDeps["emergencyExecution"];
  rebuildTransport?: PipelineDeps["rebuildTransport"];
  phaseHealth?: PipelineDeps["phaseHealth"];
  registry?: PipelineDeps["registry"];
  bridgeLockPath?: PipelineDeps["bridgeLockPath"];
  conversationBuffer?: { clear: (key: string) => void };
  bufKey?: string;
}

export type CommandHandler = (text: string, ctx: CommandContext) => Promise<boolean>;
