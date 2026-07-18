import { randomUUID } from "node:crypto";

export interface ProviderCallStart {
  provider?: string;
  model?: string;
  candidate?: string;
  fallbackFrom?: string;
  startedAt: number;
}

export interface ProviderCallTerminal {
  result: "success" | "failure" | "aborted" | "unknown";
  endedAt: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ProviderCallHandle {
  readonly providerCallId: string;
  readonly ordinal: number;
  end(terminal: ProviderCallTerminal): void;
}

export interface ExecutionTelemetryScope {
  readonly executionId: string;
  beginProviderCall(start: ProviderCallStart): ProviderCallHandle;
  snapshot(): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined;
  close(): void;
}

let pcSeq = 0;

export function createExecutionTelemetryScope(executionId: string): ExecutionTelemetryScope {
  let closed = false;
  const calls: Array<{
    start: ProviderCallStart;
    terminal?: ProviderCallTerminal;
  }> = [];

  return {
    executionId,
    beginProviderCall(start: ProviderCallStart): ProviderCallHandle {
      if (closed) {
        return {
          providerCallId: "",
          ordinal: -1,
          end() {},
        };
      }
      const ordinal = pcSeq++;
      const providerCallId = `${executionId}_pc_${ordinal}_${randomUUID().slice(0, 8)}`;
      const entry = { start, terminal: undefined as ProviderCallTerminal | undefined };
      calls.push(entry);

      return {
        providerCallId,
        ordinal,
        end(terminal: ProviderCallTerminal) {
          if (entry.terminal) return;
          entry.terminal = terminal;
        },
      };
    },
    snapshot(): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined {
      if (calls.length === 0) return undefined;
      let input = 0;
      let output = 0;
      let cacheRead: number | undefined;
      let cacheWrite: number | undefined;
      let hasUsage = false;

      for (const c of calls) {
        if (c.terminal?.input != null) {
          input += c.terminal.input;
          output += c.terminal.output ?? 0;
          if (c.terminal.cacheRead != null) cacheRead = (cacheRead ?? 0) + c.terminal.cacheRead;
          if (c.terminal.cacheWrite != null) cacheWrite = (cacheWrite ?? 0) + c.terminal.cacheWrite;
          hasUsage = true;
        }
      }

      if (!hasUsage) return undefined;
      return { input, output, cacheRead, cacheWrite };
    },
    close() {
      closed = true;
    },
  };
}
