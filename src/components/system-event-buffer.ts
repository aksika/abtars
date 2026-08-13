/**
 * system-event-buffer.ts — Buffers silent system events for injection (#844).
 * Drained before the Main prompt in the message pipeline.
 */

const buffer: string[] = [];

export function bufferSystemEvent(message: string): void {
  buffer.push(message);
}

/** #1652: format a fault notice from an agent over the existing buffer. */
export function bufferAgentNotice(from: string, text: string): void {
  bufferSystemEvent(`[${from.trim().toUpperCase()} SAYS] ${text}`);
}

export function drainSystemEvents(): string[] {
  return buffer.splice(0);
}
