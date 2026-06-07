/**
 * system-event-buffer.ts — Buffers silent system events for injection (#844).
 * Drained before each prompt in the message pipeline.
 */

const buffer: string[] = [];

export function bufferSystemEvent(message: string): void {
  buffer.push(message);
}

export function drainSystemEvents(): string[] {
  return buffer.splice(0);
}
