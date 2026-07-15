/**
 * pi-event-projection.ts — pure projection of official Pi events into bounded
 * durable progress + a settlement signal. Kept side-effect free (no logging, no
 * store) so it can be unit-tested exhaustively; the executor applies the result.
 *
 * #1426 invariants enforced here:
 *  - agent_end carries `willRetry`: settle completion only on the final,
 *    non-retrying agent_end. Settling on a retrying agent_end would close the
 *    process while Pi is about to re-run it.
 *  - message_update is a high-frequency streaming event: it must not produce
 *    progress or warnings (only activity, touched by the caller).
 *  - extension_error content is bounded before it can reach progress metadata
 *    or logs; raw error text/stacks are truncated, never stored verbatim.
 *  - the switch is exhaustive over the official event union at compile time, so
 *    a newly added Pi event forces an explicit case here.
 */
import type { PiAgentEvent } from "./pi-rpc-client.js";
import { MAX_ERROR_CHARS } from "./types.js";

export type PiEventProjection = {
  /** Bounded progress entries to persist (0..n). */
  progress: Array<{ type: string; json: string }>;
  /** True when this event signals agent completion (final, non-retrying agent_end). */
  settleCompletion: boolean;
  /** Optional bounded log line for the executor to emit. */
  log?: { level: "warn" | "debug"; message: string };
};

/** No durable projection; the caller still touches activity for every event. */
const IGNORE: PiEventProjection = { progress: [], settleCompletion: false };

function progress(type: string, json: string): PiEventProjection {
  return { progress: [{ type, json }], settleCompletion: false };
}

/**
 * Project an official Pi agent/RPC event. Pure: no side effects. All content is
 * bounded before it can reach progress metadata or logs.
 */
export function projectPiEvent(event: PiAgentEvent): PiEventProjection {
  switch (event.type) {
    case "agent_start":
      return progress("agent_start", "{}");
    case "agent_end":
      // #1426: willRetry=true means Pi will auto-retry; do NOT settle.
      if (event.willRetry) {
        return progress("auto_retry", JSON.stringify({ status: "agent_end_will_retry" }));
      }
      return { progress: [], settleCompletion: true };
    case "tool_execution_start":
      return progress("tool_execution_start", JSON.stringify({ name: event.toolName }));
    case "tool_execution_end":
      return progress("tool_execution_end", JSON.stringify({ name: event.toolName }));
    case "compaction_start":
      return progress("compaction", JSON.stringify({ status: "started" }));
    case "compaction_end":
      return progress("compaction", JSON.stringify({ status: "ended" }));
    case "auto_retry_start":
      return progress("auto_retry", JSON.stringify({ status: "started", attempt: event.attempt }));
    case "auto_retry_end":
      return progress("auto_retry", JSON.stringify({ status: "ended", attempt: event.attempt }));
    case "agent_settled":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_update":
    case "message_end":
    case "queue_update":
    case "entry_appended":
    case "session_info_changed":
    case "thinking_level_changed":
    case "tool_execution_update":
      return IGNORE;
    case "extension_error": {
      // Bound everything; never persist or log raw payloads/stacks.
      const extensionPath = (event.extensionPath ?? "").slice(0, 200);
      const eventName = (event.event ?? "").slice(0, 200);
      const boundedError = (event.error ?? "").slice(0, MAX_ERROR_CHARS);
      return {
        progress: [{ type: "extension_error", json: JSON.stringify({ extensionPath, event: eventName }) }],
        settleCompletion: false,
        log: {
          level: "warn",
          message: `Extension error: path=${extensionPath || "?"} event=${eventName || "?"} error=${boundedError}`,
        },
      };
    }
    default: {
      // Compile-time exhaustiveness: a new official event forces a case above.
      // At runtime an unexpected frame (e.g. a future Pi version) still lands
      // here because frames are cast from parsed JSON at the wire boundary.
      const _exhaustive: never = event;
      return {
        progress: [],
        settleCompletion: false,
        log: {
          level: "debug",
          message: `Unrecognized Pi event: type=${(_exhaustive as { type?: string }).type ?? "unknown"}`,
        },
      };
    }
  }
}
