import { createHash } from "node:crypto";

export type MemoryMutationFamily = "inbound" | "assistant" | "feedback" | "compact";

const KEY_PREFIX = "abtars-mem-v1";
const MAX_KEY_LENGTH = 128;

function sha256Base64url(value: string): string {
  return createHash("sha256")
    .update(value, "utf-8")
    .digest("base64url");
}

/**
 * Build a bounded idempotency key for memory mutations.
 *
 * Encodes the identity tuple as a fixed-order JSON array, SHA-256 hashes the
 * UTF-8 bytes, and base64url-encodes without padding. Returns a string in the
 * format `abtars-mem-v1:<family>:<digest>`.
 *
 * The digest covers identity only — never content, prompts, or credentials.
 * A changed payload under the same identity still reaches abmind's ledger as
 * a legitimate conflict.
 */
export function memoryOperationKey(
  family: MemoryMutationFamily,
  identity: readonly string[],
): string {
  const json = JSON.stringify(identity);
  const digest = sha256Base64url(json);
  const key = `${KEY_PREFIX}:${family}:${digest}`;
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `memoryOperationKey exceeds ${MAX_KEY_LENGTH} chars (${key.length}) for family=${family} identity=${json.slice(0, 80)}`,
    );
  }
  return key;
}

function requireNonEmpty(value: string, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`memoryOperationKey: ${label} must be non-empty`);
  }
}

/**
 * Build an inbound-message operation key.
 *
 * Identity tuple: [platform, channelId, threadId-or-empty, userId, messageId]
 *
 * Every adapter must populate `messageId` losslessly before calling this.
 */
export function inboundMessageKey(
  platform: string,
  channelId: string,
  threadId: string | null | undefined,
  userId: string,
  messageId: string,
): string {
  requireNonEmpty(platform, "platform");
  requireNonEmpty(channelId, "channelId");
  requireNonEmpty(userId, "userId");
  requireNonEmpty(messageId, "messageId");
  return memoryOperationKey("inbound", [
    platform,
    channelId,
    threadId ?? "",
    userId,
    messageId,
  ]);
}

/** Build an inbound key for internal sources that have no platform message ID. */
export function inboundExecutionKey(
  platform: string,
  channelId: string,
  threadId: string | null | undefined,
  userId: string,
  executionId: string,
): string {
  requireNonEmpty(platform, "platform");
  requireNonEmpty(channelId, "channelId");
  requireNonEmpty(userId, "userId");
  requireNonEmpty(executionId, "executionId");
  return memoryOperationKey("inbound", [
    platform,
    channelId,
    threadId ?? "",
    userId,
    `execution:${executionId}`,
  ]);
}

/**
 * Build an assistant-record operation key.
 *
 * Identity tuple: [platform, channelId, threadId-or-empty, userId, deliveredMessageId]
 *
 * When the adapter returns no delivery ID, use the `executionId` from the
 * DeliveryCorrelation captured before async cleanup.
 */
export function assistantMessageKey(
  platform: string,
  channelId: string,
  threadId: string | null | undefined,
  userId: string,
  deliveredMessageId: string,
): string {
  requireNonEmpty(platform, "platform");
  requireNonEmpty(channelId, "channelId");
  requireNonEmpty(userId, "userId");
  requireNonEmpty(deliveredMessageId, "deliveredMessageId");
  return memoryOperationKey("assistant", [
    platform,
    channelId,
    threadId ?? "",
    userId,
    deliveredMessageId,
  ]);
}

/**
 * Build a feedback-record operation key.
 *
 * Identity tuple: [platform, channelId, userId, messageId, memoryId, feedbackType]
 *
 * Includes feedbackType so independent cite/reject events on the same message
 * do not collide, but replaying the identical reaction safely replays.
 */
export function feedbackKey(
  platform: string,
  channelId: string,
  userId: string,
  messageId: string,
  memoryId: number,
  feedbackType: string,
): string {
  requireNonEmpty(platform, "platform");
  requireNonEmpty(channelId, "channelId");
  requireNonEmpty(userId, "userId");
  requireNonEmpty(messageId, "messageId");
  requireNonEmpty(feedbackType, "feedbackType");
  return memoryOperationKey("feedback", [
    platform,
    channelId,
    userId,
    messageId,
    String(memoryId),
    feedbackType,
  ]);
}
