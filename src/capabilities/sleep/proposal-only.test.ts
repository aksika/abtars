/**
 * proposal-only.test.ts — #1859 host enforcement for fenced Dreamy turns.
 *
 * The lease declares proposal-only enforcement so abmind can dispatch fenced
 * steps; the pump must hand the transport a deny-all-writes policy for those
 * turns only, and only read-only tools may survive it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../components/env-schema.js", () => ({
  getEnv: vi.fn(() => ({ sleepQuality: "normal" })),
}));

vi.mock("../../components/system-event-buffer.js", () => ({
  bufferSystemEvent: vi.fn(),
}));

vi.mock("../../components/logger.js", () => ({
  logInfo: vi.fn(),
  logTrace: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  redactSecrets: (value: string) => value,
}));

vi.mock("../../components/transport/bridge-lock-transport.js", () => ({
  writeSleepStatus: vi.fn(),
}));

import { createSleepHandle, PROPOSAL_ONLY_TOOLS } from "./index.js";
import { checkTool } from "../../components/tool-sandbox.js";
import { classifyContent } from "../../components/clean-response.js";

function settleSpin(result: string, sessionId = "s1"): { result: string; sessionId: string; outcome: ReturnType<typeof classifyContent> } {
  return { result, sessionId, outcome: classifyContent(result) };
}

function makeFakeClient(proposalOnly: boolean): unknown {
  const request = {
    status: "ok",
    completionRequest: {
      completionId: "c1",
      runId: "run-1",
      stepId: "extract-memories",
      prompt: "PROPOSAL-EXTRACTION-V1 — extract",
      deadline: Date.now() + 120_000,
      ...(proposalOnly ? { proposalOnly: true } : {}),
    },
  };
  return {
    sleep: {
      start: vi.fn().mockResolvedValue({ status: "accepted", runId: "run-1" }),
      status: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      events: vi.fn(),
      runtime: {
        open: vi.fn().mockResolvedValue({ status: "ok", leaseId: "lease-1" }),
        next: vi.fn().mockResolvedValueOnce(request).mockResolvedValue({ status: "lease_expired" }),
        complete: vi.fn().mockResolvedValue({ status: "ok" }),
        fail: vi.fn(),
        close: vi.fn(),
      },
    },
  };
}

async function settleTicks(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 1));
}

describe("#1859 proposal-only host enforcement", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("derives an empty execute_bash boolean, denies memory_store/memory_edit, and allows read-only recall", () => {
    // The exported policy is the single source both presentation and dispatch
    // read through the transport sandbox.
    expect(checkTool("execute_bash", PROPOSAL_ONLY_TOOLS).allowed).toBe(false);
    expect(checkTool("memory_store", PROPOSAL_ONLY_TOOLS).allowed).toBe(false);
    expect(checkTool("memory_edit", PROPOSAL_ONLY_TOOLS).allowed).toBe(false);
    expect(checkTool("task_manage", PROPOSAL_ONLY_TOOLS).allowed).toBe(false);
    expect(checkTool("memory_recall", PROPOSAL_ONLY_TOOLS).allowed).toBe(true);
  });

  it("declares the capability at lease open and passes the fence to spin for proposal-only requests", async () => {
    const client = makeFakeClient(true) as any;
    const spin = vi.fn().mockResolvedValue(settleSpin("proposals"));
    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.open).toHaveBeenCalledWith("abtars", undefined, { proposalOnly: true });
    const spinOpts = spin.mock.calls[0]![0] as { tools?: unknown; executionOrigin?: string };
    expect(spinOpts.tools, "a proposal-only turn must carry the deny-writes policy").toBe(PROPOSAL_ONLY_TOOLS);
    expect(spinOpts.executionOrigin).toBe("sleep");
  });

  it("leaves an ordinary sleep turn on the unchanged tool surface", async () => {
    const client = makeFakeClient(false) as any;
    const spin = vi.fn().mockResolvedValue(settleSpin("done"));
    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    const spinOpts = spin.mock.calls[0]![0] as { tools?: unknown };
    expect(spinOpts.tools).toBeUndefined();
  });
});
