/**
 * prompt-builder.ts — Build the augmented prompt for a user message.
 * Handles: timestamp, media path, group context, session-start injection,
 * active recall, large-message interception, injection scan.
 */

import { logInfo, logDebug, logTrace } from "../logger.js";
import { localTime } from "../../utils/local-time.js";
import { interceptLargeMessage } from "../message-interceptor.js";
import { abmind } from "../../utils/abmind-lazy.js";
import { getEnv } from "../env-schema.js";
import type { AbtarsMemoryRuntime } from "../memory-runtime.js";
import type { ConversationBuffer } from "../conversation-buffer.js";
import type { InboundMessage } from "../../types/platform.js";
import type { UserRegistry } from "../user-registry.js";

const TAG = "pipeline";
const ACTIVE_MEMORY_LIMIT = 5;

export interface BuildPromptDeps {
  memoryRuntime: AbtarsMemoryRuntime | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  sessionManager: import("../spin.js").Spin;
  conversationBuffer: ConversationBuffer;
  contextPercent: number;
  maxContext?: number;
  isAcp?: boolean;
}

export interface BuildPromptResult {
  prompt: string;
  isSessionStart: boolean;
  imageContent?: { mime: string; base64: string; path: string };
  recalledHits?: Array<{ id: number; contentEn: string }>;
  /** #1329: the SQLite message ID assigned to the just-persisted raw user row. */
  currentMessageId?: number;
  /** #1335: structured current turn components for Pi cache-stable assembly. */
  currentTurn?: {
    rawText: string;
    volatileContext: Array<{
      kind: "timestamp" | "recall" | "session_start" | "runtime" | "other";
      content: string;
    }>;
  };
}

export async function buildPrompt(
  msg: InboundMessage,
  text: string,
  deps: BuildPromptDeps,
  registry: UserRegistry,
): Promise<BuildPromptResult> {
  const { memoryRuntime, conversationBuffer, contextPercent } = deps;
  const { channelId, isGroup } = msg;
  const userId = msg.userId;
  const sessionKey = deps.sessionManager.getActiveSessionId(userId, msg.platform);
  const bufKey = `${msg.platform}:${channelId}`;
  const { spin } = await import("../spin.js");
  const pSession = spin.getSessionById(sessionKey);

  // #1335: collect volatile context blocks separately from raw user text
  const volatileContext: Array<{ kind: "timestamp" | "recall" | "session_start" | "runtime" | "other"; content: string }> = [];

  // --- Timestamp prefix ---
  const tsPrefix = `[${localTime()}]`;
  let prompt = `${tsPrefix} ${text}`;
  volatileContext.push({ kind: "timestamp", content: tsPrefix });
  let imageContent: { mime: string; base64: string; path: string } | undefined;
  if (msg.mediaPath) {
    if (deps.isAcp) {
      // ACP: agent reads files itself — just provide the path, no I/O
      prompt += `\nImage saved at: ${msg.mediaPath}`;
    } else {
      // Pi API: encode for the embedded provider boundary
      const { readFileSync } = await import("node:fs");
      const ext = msg.mediaPath.split(".").pop()?.toLowerCase();
      const visionMimes: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
      const mime = ext ? visionMimes[ext] : undefined;
      if (mime) {
        try {
          const buf = readFileSync(msg.mediaPath);
          const b64 = buf.toString("base64");
          const maxCtxPct = parseInt(process.env["IMAGE_MAX_CONTEXT_PCT"] ?? "30", 10);
          const maxContext = deps.maxContext ?? 128000;
          const imgTokens = Math.ceil(b64.length / 4);
          if (imgTokens <= maxContext * (maxCtxPct / 100)) {
            imageContent = { mime, base64: b64, path: msg.mediaPath };
          } else {
            prompt += `\n⚠️ Image too large. Saved at: ${msg.mediaPath}`;
          }
        } catch {
          prompt += `\nFile saved at: ${msg.mediaPath}`;
        }
      } else {
        prompt += `\nFile saved at: ${msg.mediaPath}`;
      }
    }
  }

  // --- Group buffer drain ---
  if (isGroup) {
    const context = conversationBuffer.drain(bufKey);
    if (context) {
      volatileContext.push({ kind: "other", content: context });
      prompt = context + text;
      logDebug(TAG, "Prepended group context to prompt");
    }
  }

  // --- Session-start injection ---
  const entry = pSession;
  const isSessionStart = !entry || entry.pendingStart || !entry.seen;
  logTrace(TAG, `session-state: key=${sessionKey} seen=${entry?.seen} pendingStart=${entry?.pendingStart} isSessionStart=${isSessionStart}`);
  if (isSessionStart && memoryRuntime?.state === "ready") {
    try {
      const sessionCtx = await memoryRuntime.assembleSessionContext({
        identity: { principalId: userId, executionId: sessionKey },
        maxChars: deps.maxContext ? Math.floor(deps.maxContext * 0.15) : undefined,
      });
      const sessionParts = [sessionCtx.coreKnowledge, sessionCtx.recall, sessionCtx.wakeUp].filter(Boolean);
      if (sessionParts.length > 0) volatileContext.push({ kind: "session_start", content: sessionParts.join("\n\n") });
    } catch (err) {
      logDebug(TAG, `Session context unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Rebuild combined prompt with session context
    const sessionParts = volatileContext.map(v => v.content);
    prompt = `[CONTEXT — do not respond to this section]\n${sessionParts.join("\n\n")}\n[/CONTEXT]\n\n${tsPrefix} ${text}`;
  }
  if (entry) {
    entry.seen = true;
    entry.pendingStart = false;
  }

  // Record user message to memory
  const userRole = registry.byUserId.get(userId)?.role;
  logTrace(TAG, `recordMessage gate: memory=${memoryRuntime?.state === "ready"} userId=${userId} userRole=${userRole}`);
  let currentMessageId: number | undefined;
  if (memoryRuntime?.state === "ready" && userRole !== "guest" && !text.startsWith("[SESSION START]")) {
    const numericMsgId = typeof msg.messageId === "number" ? msg.messageId : undefined;
    const messageTimestamp = Date.now();
    const id = await memoryRuntime.recordMessage({ role: "user", content: text, timestamp: messageTimestamp, userId, sessionId: sessionKey, platformMessageId: numericMsgId }, `message-${userId}-${msg.platform}-${numericMsgId ?? messageTimestamp}`);
    if (typeof id === "number") currentMessageId = id;
  }

  // --- Active recall ---
  let recalledHits: Array<{ id: number; contentEn: string }> | undefined;
  if (getEnv().activeMemory && memoryRuntime?.state === "ready") {
    const userEntry = registry.byUserId.get(userId);
    if (userEntry?.role !== "guest" && (contextPercent < 0 || contextPercent < getEnv().ctxCompactPct)) {
      try {
        const t0 = performance.now();
        const priming = pSession?.primingTerms ?? [];
        const recall = await memoryRuntime.recall({ query: [...new Set([text, ...priming])].join(" "), userId, limit: ACTIVE_MEMORY_LIMIT });
        const TRIVIAL_TTL_MS = 36 * 60 * 60_000;
        const nowMs = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hits = recall.hits.filter((h: any) => {
          if (h.score <= 0.70) return false;
          if (h.memoryType === "fact" && h.score < 1.0 && h.createdAt && nowMs - h.createdAt > TRIVIAL_TTL_MS) {
            if (!h.emotionTags && !h.importanceFlags) return false;
          }
          return true;
        });
        if (hits.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lines = hits.map((h: any) => abmind()?.renderMemory({
            content_en: h.content,
          }) ?? h.content);
          const block = `[MEMORY CONTEXT — auto-recalled, do not repeat verbatim]\n${lines.join("\n")}\n[/MEMORY CONTEXT]`;
          volatileContext.push({ kind: "recall", content: block });
          prompt = `${block}\n\n${prompt}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          recalledHits = hits.filter((h: any) => h.memoryId != null).map((h: any) => ({ id: h.memoryId as number, contentEn: h.content as string }));
          logDebug(TAG, `Active recall: ${hits.length} hits, ${block.length} chars, ${Math.round(performance.now() - t0)}ms`);
          logTrace(TAG, `recall content: ${block}`);
        }
      } catch (err) {
        logDebug(TAG, `Active recall failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- Intercept oversized prompts (skip on session-start) ---
  if (!isSessionStart) {
    prompt = interceptLargeMessage(prompt).text;
  }

  // --- Injection scan for non-master ---
  if (userRole !== "master" && text.length > 10) {
    const scanFn = abmind()?.scanForInjection;
    if (scanFn) {
      const scan = scanFn(text);
      if (!scan.safe) {
        logInfo(TAG, `Injection blocked from ${userId}: ${scan.flags.map((f: { category: string }) => f.category).join(", ")}`);
      return { prompt: "__INJECTION_BLOCKED__", isSessionStart, imageContent: undefined, recalledHits: undefined, currentMessageId: undefined };
    }
    }
  }

  // #1335: structured current turn for Direct API cache-stable assembly
  const currentTurn: BuildPromptResult["currentTurn"] = {
    rawText: text,
    volatileContext,
  };

  return { prompt, isSessionStart, imageContent, recalledHits, currentMessageId, currentTurn };
}
