import type { AcpRequest, AcpResponse, AcpNotification, AcpMessage } from "../types/index.js";

let nextId = 1;

/** Generate a monotonically increasing JSON-RPC request ID. */
export function nextRequestId(): number {
  return nextId++;
}

/** Reset the ID counter (for testing). */
export function resetRequestId(): void {
  nextId = 1;
}

/** Serialize a JSON-RPC message to a newline-delimited string. */
export function serialize(message: AcpRequest | AcpResponse): string {
  return JSON.stringify(message) + "\n";
}

/**
 * Parse a newline-delimited JSON-RPC line into a typed ACP message.
 * Responses have an `id` field; notifications do not.
 */
export function parse(line: string): AcpMessage {
  const trimmed = line.trim();
  if (trimmed === "") {
    throw new Error("Cannot parse empty JSON-RPC line");
  }

  const obj = JSON.parse(trimmed) as Record<string, unknown>;

  if (obj["jsonrpc"] !== "2.0") {
    throw new Error(`Invalid JSON-RPC version: ${String(obj["jsonrpc"])}`);
  }

  // Responses have an `id` field
  if ("id" in obj) {
    return obj as unknown as AcpResponse;
  }

  // Notifications have a `method` field but no `id`
  if ("method" in obj) {
    return obj as unknown as AcpNotification;
  }

  throw new Error("Unrecognized JSON-RPC message: missing both id and method");
}

/** Build a JSON-RPC 2.0 request object. */
export function buildRequest(method: string, params: Record<string, unknown>): AcpRequest {
  return {
    jsonrpc: "2.0",
    id: nextRequestId(),
    method,
    params,
  };
}
