import { logWarn } from "../logger.js";

/** Retry a send operation on transient network errors (fetch failed, timeout, 5xx). */
export async function retrySend<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = msg.includes("fetch failed") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || /^5\d\d/.test(msg);
      if (!transient || i === attempts - 1) throw err;
      const delay = 1000 * Math.pow(3, i);
      logWarn("pipeline", `Delivery failed (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${msg}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
