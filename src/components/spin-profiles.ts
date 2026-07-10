/**
 * spin-profiles.ts — Per-session-type behavior registry (#1271).
 *
 * Replaces the per-type `if (type === ...)` branches that used to live in
 * `execute()` and `executeOrc()`. Adding a new SessionType = adding a row to
 * SESSION_PROFILES; `spin()` itself contains no type-specific code.
 */

import type { AgentName } from "./subagent-runtime.js";
import type { ManagedSession, SessionType } from "./spin-types.js";
import { sessionType } from "./spin-types.js";

/** A prompt decorator wraps/prepends context onto the outgoing prompt. */
export type PromptDecorator = (
  prompt: string,
  ctx: { session: ManagedSession; cardId?: number; parentCardId?: number },
) => Promise<string> | string;

export interface SessionProfile {
  /** Agent to route the prompt to. */
  agent: AgentName;
  /** "oneshot" uses runtime.complete(); "persistent" uses session.transport.sendPrompt. */
  transportMode: "oneshot" | "persistent";
  /** How spin() resolves the ManagedSession — replaces per-type branches. */
  resolution: "active" | "singleton" | "transient";
  /** What happens to the session record after the call returns. */
  terminateAfter: "call" | "response" | "external";
  /** Ordered prompt transforms (decorator at index N prepends; last in list = outermost). */
  decorators: readonly PromptDecorator[];
  /** Side-effect hook fired before the prompt is sent. */
  beforePrompt?: (session: ManagedSession, cardId?: number) => Promise<void> | void;
  /** Side-effect hook fired after the prompt resolves (success OR failure). */
  afterPrompt?:  (session: ManagedSession, cardId?: number) => Promise<void> | void;
}

// ── Reusable decorators ────────────────────────────────────────────────

const soulBundle: PromptDecorator = async (prompt, { session }) => {
  const { buildSoulBundle } = await import("./soul-bundle.js");
  const bundle = buildSoulBundle(sessionType(session));
  return bundle ? `${bundle}\n\n---\n\n${prompt}` : prompt;
};

const channelMessages: PromptDecorator = async (prompt, { cardId, parentCardId }) => {
  if (cardId === undefined) return prompt;
  const { channelUnread } = await import("./tasks/kanban-channel.js");
  const workerName = `Worker-${String(cardId).padStart(2, "0")}`;
  const msgs = channelUnread(parentCardId ?? cardId, workerName);
  if (msgs.length === 0) return prompt;
  const lines = msgs.map(m => `[${m.from_agent}→${m.to_agent}]${m.directive ? " ⚡" : ""} ${m.message}`);
  return `[CHANNEL — ${msgs.length} message(s) for ${workerName}]\n${lines.join("\n")}\n[/CHANNEL]\n\n${prompt}`;
};

const orcContext: PromptDecorator = async (prompt, { cardId }) => {
  const { localDateTime } = await import("../utils/local-time.js");
  return `[CONTEXT — do not respond to this section]\n[PROJECT] card #${cardId}\n[CURRENT TIME] ${localDateTime()}\n[/CONTEXT]\n\n${prompt}`;
};

const orcNotifications: PromptDecorator = async (prompt, { cardId }) => {
  if (cardId === undefined) return prompt;
  const { drainOrcNotifications } = await import("./spin-notifications.js");
  const n = drainOrcNotifications(cardId);
  return n.length ? `${n.join("\n")}\n\n${prompt}` : prompt;
};

const orcChannel: PromptDecorator = async (prompt, { cardId }) => {
  if (cardId === undefined) return prompt;
  const { channelUnread } = await import("./tasks/kanban-channel.js");
  const msgs = channelUnread(cardId, "Orc");
  if (msgs.length === 0) return prompt;
  const lines = msgs.map(m => `[${m.from_agent}→${m.to_agent}]${m.directive ? " ⚡" : ""} ${m.message}`);
  return `[CHANNEL — ${msgs.length} message(s)]\n${lines.join("\n")}\n[/CHANNEL]\n\n${prompt}`;
};

// ── The registry ───────────────────────────────────────────────────────

export const SESSION_PROFILES: Record<SessionType, SessionProfile> = {
  A: { agent: "professor", transportMode: "persistent", resolution: "active",    terminateAfter: "external",  decorators: [] },
  B: { agent: "browsie",   transportMode: "oneshot",    resolution: "transient", terminateAfter: "response", decorators: [soulBundle] },
  C: { agent: "coding",    transportMode: "oneshot",    resolution: "transient", terminateAfter: "response", decorators: [soulBundle] },
  T: { agent: "professor", transportMode: "oneshot",    resolution: "transient", terminateAfter: "response", decorators: [soulBundle, channelMessages] },
  P: { agent: "professor", transportMode: "oneshot",    resolution: "transient", terminateAfter: "response", decorators: [soulBundle] },
  S: { agent: "coding",    transportMode: "oneshot",    resolution: "transient", terminateAfter: "call",     decorators: [] },
  W: { agent: "browsie",   transportMode: "oneshot",    resolution: "transient", terminateAfter: "response", decorators: [soulBundle, channelMessages] },
  H: { agent: "coding",    transportMode: "oneshot",    resolution: "transient", terminateAfter: "response", decorators: [soulBundle] },
  D: { agent: "dreamy",    transportMode: "persistent", resolution: "transient", terminateAfter: "external", decorators: [] },
  O: {
    agent: "browsie",                    // ← preserves current Orc agent (NOT professor)
    transportMode: "persistent",
    resolution: "singleton",             // ← one Orc; reuse the visible O session
    terminateAfter: "external",
    decorators: [orcContext, soulBundle, orcNotifications, orcChannel],
    beforePrompt: async (_session, cardId) => {
      const { updateBridgeLockField } = await import("./transport/bridge-lock-transport.js");
      const { setActiveOrcCard } = await import("./transport/orc-tools.js");
      if (cardId !== undefined) { updateBridgeLockField("orc_active", cardId); setActiveOrcCard(cardId); }
    },
    afterPrompt: async () => {
      const { updateBridgeLockField } = await import("./transport/bridge-lock-transport.js");
      const { setActiveOrcCard } = await import("./transport/orc-tools.js");
      updateBridgeLockField("orc_active", null); setActiveOrcCard(null);
    },
  },
};

/** #1327: defensive — the only valid SessionTypes are the keys of SESSION_PROFILES.
 *  Used by drainQueued, the kanban_manage tool, and anywhere a runtime value
 *  (card.type, query param) needs to be checked against the type system.
 *  `card.type` is documented as "task, bug, feature, ..." in the kanban schema
 *  (a ticket category) but is ALSO used as the SessionType for Spin dispatch
 *  in drainQueued. This guard is the runtime boundary that keeps the two
 *  semantics separate. */
export function isValidSessionType(t: unknown): t is SessionType {
  return typeof t === "string" && (SESSION_PROFILES as Record<string, unknown>)[t] !== undefined;
}

/** #1327: returns undefined for unknown types (was previously a silent
 *  `Record<K,V>` access that returned undefined for any string, but the
 *  TypeScript signature lied and callers didn't handle it). Now the return
 *  type is explicit; spin() and drainQueued both check + handle undefined. */
export function profileFor(type: SessionType): SessionProfile | undefined {
  return SESSION_PROFILES[type];
}
