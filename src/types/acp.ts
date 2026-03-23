/** JSON-RPC 2.0 request sent to kiro-cli acp via stdin. */
export type AcpRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
};

/** JSON-RPC 2.0 response received from kiro-cli acp via stdout. */
export type AcpResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

/** JSON-RPC 2.0 notification (no id) received from kiro-cli acp. */
export type AcpNotification = {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
};

/** Union of all inbound ACP messages (responses have id, notifications don't). */
export type AcpMessage = AcpResponse | AcpNotification;

/** Discriminated session update types emitted via session/update notifications. */
export type AcpSessionUpdate =
  | { type: "plan"; content: unknown }
  | { type: "agent_message_chunk"; content: string }
  | { type: "tool_call"; toolName: string; content: unknown }
  | { type: "tool_call_update"; toolName: string; content: unknown }
  | { type: "user_message_chunk"; content: string };

/** Reasons a session prompt can stop. */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_model_requests"
  | "refusal"
  | "cancelled";

/** Result returned when a session/prompt completes. */
export type AcpPromptResult = {
  stopReason: AcpStopReason;
};
