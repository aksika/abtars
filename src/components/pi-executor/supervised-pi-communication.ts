/**
 * supervised-pi-communication.ts — #1643: typed Worker→Orc communication
 * routing for supervised Pi runs.
 *
 * The extension artifact supplies Worker-facing vocabulary; this component is
 * the abtars authority for identity, persistence, and lifecycle. It recognizes
 * `tell_orc` ONLY from the typed raw RPC `tool_execution_start.toolName` frame
 * (never by parsing notify/title/question text), revalidates the live
 * ownership tuple, and durably posts one bounded message to the root project
 * card's agent_channel through the once-only channel operation.
 *
 * `ask_orc` needs no host component: its ordinary extension_ui_request flows
 * through the existing #1638 input-suspension lifecycle unchanged.
 */
import { kanbanGetCard, resolveRootId } from "../tasks/kanban-board.js";
import { channelPostOnce } from "../tasks/kanban-channel.js";
import type { PiRunStore } from "./pi-run-store.js";
import type { PiRunStatus } from "./types.js";
import type { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { WORKER_ORC_EXTENSION_PROTOCOL } from "./worker-orc-extension.js";

export const TELL_ORC_TOOL_NAME = "tell_orc";

/** Bounded message contract mirrored from the artifact schema. */
const MAX_TELL_MESSAGE = 1000;

/** Bounded channel field contract. */
const MAX_SOURCE_REF = 200;
const MAX_FROM_LABEL = 80;
const MAX_TOOL_CALL_ID = 128;

export type SupervisedCommunicationOutcome = "posted" | "duplicate" | "ignored" | "unavailable";

export interface SupervisedPiCommunicationPort {
  /** Handle one raw typed tool-start frame. Synchronous: the channel store is
   * synchronous SQLite. Returns the bounded outcome; never throws. */
  onToolStart(input: {
    runId: string;
    piGeneration: number;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): SupervisedCommunicationOutcome;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<PiRunStatus> = new Set([
  "completed", "failed", "cancelled", "interrupted",
]);

export class SupervisedPiCommunication implements SupervisedPiCommunicationPort {
  constructor(
    private readonly piStore: PiRunStore,
    private readonly workerStore: WorkerSupervisionStore,
  ) {}

  onToolStart(input: {
    runId: string;
    piGeneration: number;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): SupervisedCommunicationOutcome {
    try {
      return this._onToolStart(input);
    } catch {
      // A communication failure must never throw into the Pi event loop.
      return input.toolName === TELL_ORC_TOOL_NAME ? "unavailable" : "ignored";
    }
  }

  private _onToolStart(input: {
    runId: string;
    piGeneration: number;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): SupervisedCommunicationOutcome {
    // 1. Exact typed tool name — everything else is ignored.
    if (input.toolName !== TELL_ORC_TOOL_NAME) return "ignored";

    // 2. Durable run ownership: supervised origin, matching generation, and a
    //    live non-terminal state.
    const run = this.piStore.get(input.runId);
    if (!run) return "ignored";
    if (run.origin !== "supervised") return "ignored";
    if (run.executionGeneration !== input.piGeneration) return "ignored";
    if (TERMINAL_RUN_STATUSES.has(run.status) || (run.status !== "starting" && run.status !== "running")) return "ignored";

    // 3. Live Worker attempt binding at the exact generation, not terminal.
    const attempt = this.workerStore.getAttemptForExecutorResource("pi", input.runId, input.piGeneration);
    if (!attempt) return "ignored";
    // Worker claim generations are scoped to each worker_attempt and normally
    // restart at 1. Pi execution generations belong to the single subordinate
    // run and increment across #1638 retries, so they must not be compared
    // directly. The reverse binding lookup above is the exact cross-store
    // generation fence.
    const binding = this.workerStore.getExecutorResourceBinding(attempt.id);
    if (!binding || binding.resourceId !== input.runId || binding.resourceGeneration !== input.piGeneration) return "ignored";
    if (attempt.lifecycle !== "starting" && attempt.lifecycle !== "running") return "ignored";

    // 4. Child card lineage: the attempt's card must be a W child and resolve
    //    a root project card.
    const child = kanbanGetCard(attempt.card_id);
    if (!child || child.type !== "W") return "ignored";
    const rootCardId = resolveRootId(attempt.card_id);
    if (rootCardId === undefined) return "ignored";

    // 5. Bounded message: trimmed non-empty UTF-8 under the 1,000-char
    //    contract. Malformed input produces no host mutation.
    const raw = typeof input.args === "object" && input.args !== null
      ? (input.args as Record<string, unknown>).message
      : undefined;
    if (typeof raw !== "string") return "ignored";
    const message = raw.trim();
    if (!message || message.length > MAX_TELL_MESSAGE) return "ignored";

    // 6. Durable once-only post to the ROOT project card. Worker identity is
    //    typed channel provenance, not an ad-hoc text prefix.
    if (typeof input.toolCallId !== "string") return "ignored";
    const toolCallId = input.toolCallId.trim();
    if (!toolCallId || toolCallId.length > MAX_TOOL_CALL_ID) return "ignored";
    const sourceRef = `pi-orc:v${WORKER_ORC_EXTENSION_PROTOCOL}:${input.runId}:${input.piGeneration}:${toolCallId}`;
    if (sourceRef.length > MAX_SOURCE_REF) return "ignored";
    return channelPostOnce({
      cardId: rootCardId,
      from: `Worker:${String(attempt.card_id).slice(0, MAX_FROM_LABEL)}`,
      to: "Orc",
      message,
      directive: false,
      msgType: "progress",
      sourceRef,
    });
  }
}
