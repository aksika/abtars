/**
 * net.ts — network address helpers (loopback detection).
 *
 * Shared by the Agent API server for routes that may only be driven by a
 * local CLI on the same host (see requireLoopback in agent-api-server.ts).
 * Deliberately independent of any Pi/peer protocol concepts.
 */

/** Check if an address is loopback (127.0.0.1, ::1, localhost, or absent). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return true;
  const normalized = addr.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
