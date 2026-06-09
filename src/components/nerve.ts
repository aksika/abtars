import { EventEmitter } from "node:events";
import { logInfo } from "./logger.js";

const TAG = "nerve";

export type NerveEvent = "card:queued" | "card:running" | "card:done" | "card:failed" | "card:delivered" | "message";

class Nerve extends EventEmitter {
  fire(event: NerveEvent, cardId: number, meta?: Record<string, unknown>): void {
    logInfo(TAG, `${event} card:${cardId}`);
    this.emit(event, cardId, meta);
  }
}

export const nerve = new Nerve();
