import { EventEmitter } from "node:events";
import { logDebug } from "./logger.js";

const TAG = "nerve";

export type NerveEvent = "card:queued" | "card:running" | "card:done" | "card:failed" | "card:delivered" | "message";

class Nerve extends EventEmitter {
  fire(event: NerveEvent, cardId: number, meta?: Record<string, unknown>): void {
    logDebug(TAG, `${event} card:${cardId}`);
    this.emit(event, cardId, meta);
  }
}

export const nerve = new Nerve();
