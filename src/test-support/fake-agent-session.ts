/**
 * fake-agent-session.ts — #1940 test support: fake Pi AgentSession factory.
 *
 * Test files inject this through PiCoreTransport's `sessionFactoryLoader`
 * option so slot lifecycle, steering, and result mapping can be driven
 * deterministically without a Pi installation or provider.
 */

import { vi } from "vitest";
import type { PiAgentSessionFactoryLoader } from "../components/transport/pi-agent-session-store.js";

export interface QueuedAgentTurn {
  text?: string;
  usage?: { input: number; output: number };
  contextTokens?: number | null;
  toolCalls?: number;
}

export class FakeAgentSession {
  calls: string[] = [];
  prompted: string[] = [];
  steered: string[] = [];
  followedUp: string[] = [];
  streaming = false;
  failNextPrompt: unknown = null;
  private listeners = new Set<(event: { type: string } & Record<string, unknown>) => void>();

  subscribe(listener: (event: { type: string } & Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: { type: string } & Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text: string): Promise<void> {
    this.calls.push("prompt");
    this.prompted.push(text);
    this.streaming = true;
    if (this.failNextPrompt !== null) {
      const err = this.failNextPrompt;
      this.failNextPrompt = null;
      this.streaming = false;
      throw err;
    }
  }

  async abort(): Promise<void> {
    this.calls.push("abort");
    this.streaming = false;
  }

  clearQueue(): unknown {
    this.calls.push("clearQueue");
    return {};
  }

  async waitForIdle(): Promise<void> {
    this.calls.push("waitForIdle");
  }

  dispose(): void {
    this.calls.push("dispose");
    this.streaming = false;
  }

  steer(text: string): void {
    this.calls.push("steer");
    this.steered.push(text);
  }

  followUp(text: string): void {
    this.calls.push("followUp");
    this.followedUp.push(text);
  }

  async setModel(): Promise<void> {
    this.calls.push("setModel");
  }

  setThinkingLevel(): void {
    this.calls.push("setThinkingLevel");
  }

  async compact(): Promise<unknown> {
    this.calls.push("compact");
    return { summary: "compacted" };
  }

  getContextUsage(): undefined {
    return undefined;
  }

  activeToolNames: string[] = [];

  getActiveToolNames(): string[] {
    return [...this.activeToolNames];
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.calls.push("setActiveToolsByName");
    this.activeToolNames = [...toolNames];
  }

  get isStreaming(): boolean {
    return this.streaming;
  }
}

export interface AgentSessionHarness {
  loader: PiAgentSessionFactoryLoader;
  sessions: FakeAgentSession[];
  created: Array<Record<string, unknown>>;
}

export function makeAgentSessionHarness(): AgentSessionHarness {
  const sessions: FakeAgentSession[] = [];
  const created: Array<Record<string, unknown>> = [];
  const loader = (async () => ({
    createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
      created.push(options);
      const session = new FakeAgentSession();
      sessions.push(session);
      return { session };
    }),
    SessionManager: { inMemory: vi.fn(() => ({})) },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    ModelRuntime: {
      create: vi.fn(async () => ({
        getModel: vi.fn((_providerId: string, modelId: string) => ({ id: modelId })),
        registerProvider: vi.fn(),
      })),
    },
    DefaultResourceLoader: class {
      constructor(public options: Record<string, unknown>) {}
      async reload(): Promise<void> {}
    },
  })) as PiAgentSessionFactoryLoader;
  return { loader, sessions, created };
}

/** Latest created session, failing loudly when none exists. */
export function latestSession(harness: AgentSessionHarness): FakeAgentSession {
  const session = harness.sessions[harness.sessions.length - 1];
  if (!session) throw new Error("expected a created AgentSession");
  return session;
}

/** Wait until the latest session observed the prompt, then settle it. */
export async function waitForPrompt(harness: AgentSessionHarness): Promise<FakeAgentSession> {
  for (let i = 0; i < 1000; i++) {
    const session = harness.sessions[harness.sessions.length - 1];
    if (session && session.prompted.length > 0) return session;
    await Promise.resolve();
  }
  throw new Error("fake session never received the prompt");
}

/** Settle a session's active turn as Pi would via agent events. */
export function settleAgentTurn(session: FakeAgentSession, turn: QueuedAgentTurn): void {
  if (turn.text !== undefined) {
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: turn.text }],
        ...(turn.usage !== undefined || turn.contextTokens !== undefined
          ? {
            usage: {
              input: turn.usage?.input ?? 0,
              output: turn.usage?.output ?? 0,
              ...(turn.contextTokens !== undefined && turn.contextTokens !== null
                ? { totalTokens: turn.contextTokens }
                : {}),
            },
          }
          : {}),
      },
    });
  }
  for (let i = 0; i < (turn.toolCalls ?? 0); i++) {
    session.emit({ type: "tool_execution_end", isError: false });
  }
  session.emit({ type: "agent_settled", aborted: false });
  session.streaming = false;
}
