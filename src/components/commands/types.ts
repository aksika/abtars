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
  memory: PipelineDeps["memory"];
  memoryConfig: PipelineDeps["memoryConfig"];
  nlmConfig: PipelineDeps["nlmConfig"];
  codingMode: PipelineDeps["codingMode"];
  idleSave: PipelineDeps["idleSave"];
  sessions: PipelineDeps["sessions"];
  updateCtxStart: PipelineDeps["updateCtxStart"];
  cronCurrentJob?: RunningJob | null;
  enqueueCron?: PipelineDeps["enqueueCron"];
  requestShutdown?: PipelineDeps["requestShutdown"];
  sleepProgress?: PipelineDeps["sleepProgress"];
  loadedCapabilities?: PipelineDeps["loadedCapabilities"];
  selfHealerTask?: { enabled: boolean } | null;
  hailMary?: PipelineDeps["hailMary"];
  rebuildTransport?: PipelineDeps["rebuildTransport"];
  phaseHealth?: PipelineDeps["phaseHealth"];
  registry?: PipelineDeps["registry"];
  bridgeLockPath?: PipelineDeps["bridgeLockPath"];
  conversationBuffer?: { clear: (key: string) => void };
  bufKey?: string;
}

export type CommandHandler = (text: string, ctx: CommandContext) => Promise<boolean>;
