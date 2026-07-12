export interface PiRpcRequest {
  id: string;
  cmd: string;
  args?: Record<string, unknown>;
}

export interface PiRpcResponse {
  id: string;
  type: "response" | "event" | "error";
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: string;
  data?: Record<string, unknown>;
}

export interface PiState {
  isStreaming: boolean;
  sessionId: string;
  sessionFile?: string;
  model?: string;
  provider?: string;
}

export interface PiModel {
  provider: string;
  modelId: string;
  thinking?: string;
}

export interface PiSessionStats {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalCost?: number;
}

export interface PiUiRequest {
  requestId: string;
  type: "select" | "confirm" | "input" | "editor";
  title?: string;
  description?: string;
  options?: string[];
  defaultValue?: string;
  filePattern?: string;
}

export type PiUiReply = string | number | boolean | null;

export interface PiRpcEvent {
  type: "agent_end" | "agent_start" | "tool_start" | "tool_end" | "ui" | "status" | "notify" | "progress" | "error";
  data?: Record<string, unknown>;
}
