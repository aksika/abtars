/** Hook system types — 6 lifecycle events, command-hook only. */

export type HookEvent = "BridgeStart" | "BeforeMessage" | "AfterMessage" | "SessionStart" | "SessionEnd" | "AfterPrompt";

export interface HookEntry {
  name: string;
  command: string;
  timeout?: number;
}

export interface HookConfig {
  enabled: boolean;
  hooks: Partial<Record<HookEvent, HookEntry[]>>;
}

export interface HookInput {
  event: HookEvent;
  timestamp: string;
  sessionKey: string;
  platform: string;
  userId: string;
  // BeforeMessage / AfterMessage
  chatId?: string;
  text?: string;
  // AfterMessage enrichment
  response?: string;
  model?: string;
  success?: boolean;
  error?: string;
  // SessionStart / SessionEnd
  reason?: string;
  // AfterPrompt
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number;
}

export interface HookOutput {
  decision?: "block" | "allow";
  reason?: string;
  systemMessage?: string;
}
