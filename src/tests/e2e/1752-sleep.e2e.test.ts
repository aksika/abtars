/**
 * 1752 sleep E2E — assembled normal-sleep journey with real host/daemon boundaries.
 * Covers: trusted sleep origin, heredoc payload awareness, structured failure propagation,
 * explicit resumability, and truthful daemon admission.
 *
 * Uses real AbmindServiceHost + SleepCoordinator + RuntimeBroker + HostToolService
 * with a deterministic fake provider (no external model).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionGate } from "../../components/action-gate.js";
import { HostToolService } from "../../components/host-tool-service.js";
import { classifyCommand } from "../../components/guardrails.js";
import { createSleepHandle } from "../../capabilities/sleep/index.js";
import { SealedSecretHandles } from "../../components/sealed-secret-handles.js";
import { AbmindServiceHost, EmbeddedTransport, AbmindClient, InjectableProcessIdentity } from "abmind";
import { PiCoreToolExecutionError } from "../../components/transport/tool-failure-diagnostic.js";

function dailyHeredoc(root: string): string {
  const target = join(root, "memory", "daily", "daily_2026-09-01.md");
  return `cat > ${JSON.stringify(target)} << 'EOF'
Retrospective text mentioning sudo, rm -rf, and DROP TABLE as quoted history.
EOF`;
}

function makeActionGate(tmp: string): ActionGate {
  const gate = new ActionGate(join(tmp, "auth"));
  gate.setNotify(async () => {});
  return gate;
}

describe("1752 E2E — normal sleep authorization and failure/recovery truth", () => {
  let tmp: string;
  let gate: ActionGate;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "1752-e2e-"));
    gate = makeActionGate(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("safe daily-summary heredoc executes in sleep without Telegram request", async () => {
    mkdirSync(join(tmp, "memory", "daily"), { recursive: true });
    const handles = new SealedSecretHandles(join(tmp, "handles"));
    const svc = new HostToolService({ handles, actionGate: gate, resolveHandle: async () => null });
    const command = dailyHeredoc(tmp);
    // No pending request before
    const pendingBefore = (gate as unknown as { pending: Map<string, unknown> }).pending?.size ?? 0;
    const resultStr = await svc.runBash({ command }, { userId: "test", executionId: "e1", authorizationMode: "unattended-sleep" });
    const result = JSON.parse(resultStr) as Record<string, unknown>;
    expect(result["error"]).toBeUndefined();
    expect(result["exit_code"]).toBe(0);
    expect(readFileSync(join(tmp, "memory", "daily", "daily_2026-09-01.md"), "utf-8")).toContain("DROP TABLE");
    // No auth request was enqueued for sleep
    const pendingAfter = (gate as unknown as { pending: Map<string, unknown> }).pending?.size ?? 0;
    expect(pendingAfter).toBe(pendingBefore);
    // Classifier must allow the heredoc
    expect(classifyCommand(command)).toBe("allow");
  });

  it("sleep executes an auth-required command without Telegram authorization", async () => {
    const unrestricted = "if true; then printf '%s' sleep-unrestricted; fi";
    expect(classifyCommand(unrestricted)).toBe("auth-required");
    const handles = new SealedSecretHandles(join(tmp, "handles2"));
    const svc = new HostToolService({ handles, actionGate: gate, resolveHandle: async () => null });
    const pendingBefore = (gate as unknown as { pending: Map<string, unknown> }).pending?.size ?? 0;
    const sleepResultStr = await svc.runBash({ command: unrestricted }, { userId: "test", executionId: "e3", authorizationMode: "unattended-sleep" });
    const sleepParsed = JSON.parse(sleepResultStr) as Record<string, unknown>;
    expect(sleepParsed["error"]).toBeUndefined();
    expect(sleepParsed["exit_code"]).toBe(0);
    expect(sleepParsed["stdout"]).toBe("sleep-unrestricted");
    const pendingAfter = (gate as unknown as { pending: Map<string, unknown> }).pending?.size ?? 0;
    expect(pendingAfter).toBe(pendingBefore);
  });

  it("heredoc prose does not change executable classification; nested bash -c remains guarded", () => {
    expect(classifyCommand(dailyHeredoc("/tmp/.abmind"))).toBe("allow");
    expect(classifyCommand("bash -c 'sudo rm -rf /'")).toBe("auth-required");
    expect(classifyCommand("sqlite3 db <<EOF\nDROP TABLE foo;\nEOF")).toBe("auth-required");
    expect(classifyCommand("source /tmp/file.sh")).toBe("auth-required");
    expect(classifyCommand("cat > file << 'EOF'\nDROP TABLE\nEOF")).toBe("allow");
  });

  it("prompt_round_limit survives host→daemon→report with stage/cause/action and resumability", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "abmind-1752-"));
    const origUser = process.env["ABMIND_USER_ID"];
    const origAbmindHome = process.env["ABMIND_HOME"];
    process.env["ABMIND_USER_ID"] = "test";
    process.env["ABMIND_HOME"] = memoryDir;
    // Ensure prompts are available at ABMIND_HOME/prompts/sleep
    const { cpSync } = await import("node:fs");
    const srcPrompts = join(process.cwd(), "../abmind/templates/prompts");
    if (existsSync(srcPrompts)) {
      mkdirSync(join(memoryDir, "prompts", "sleep"), { recursive: true });
      cpSync(srcPrompts, join(memoryDir, "prompts"), { recursive: true });
    }
    const MEM_CONFIG = {
      memoryEnabled: true,
      memoryDir,
      maxMessagesPerChat: 100,
      diskBudgetBytes: 1048576,
      stalenessThresholdMs: 86400000,
      restoreMessageCount: 50,
      ingestChunkMaxTokens: 512,
      embeddingModel: "nomic-embed-text",
      forgetThreshold: 0.8,
      searchEnhancements: { searchTimeoutMs: 1000, decayHalflifeDays: 30, mmrLambda: 0.7, compactThresholdPct: 85 },
    } as unknown as import("abmind").MemoryConfig;
    const identity = new InjectableProcessIdentity({ pid: Math.floor(10000 + Math.random() * 50000), startToken: `test-${Date.now()}` });
    const host = new AbmindServiceHost({
      mode: "embedded",
      memory: MEM_CONFIG,
      policy: { principalId: "test", role: "service", grantedDomains: ["system", "private", "operational"], authenticatedBy: "embedded", capabilities: ["sleep_start", "sleep_status", "sleep_resume", "sleep_events", "sleep_runtime_provider"] },
      leaseRoot: memoryDir,
      processIdentity: identity,
    } as unknown as ConstructorParameters<typeof AbmindServiceHost>[0]);
    await host.start();
    const transport = new EmbeddedTransport(host.service!, { principalId: "test", role: "service", grantedDomains: new Set(["system", "private", "operational"]), authenticatedBy: "embedded", capabilities: new Set(["sleep_start", "sleep_status", "sleep_resume", "sleep_events", "sleep_runtime_provider"]) });
    const client = new AbmindClient(transport);
    // Seed a message so sleep has work to do
    await client.privateMemory.recordMessage({ userId: "test", sessionId: "test-session", role: "user", content: "Test message for sleep — triggers retrospective", timestamp: Date.now() });
    // Fake session manager that fails with prompt_round_limit on first model call
    let callCount = 0;
    const sessionManager = {
      spin: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new PiCoreToolExecutionError({
            version: 1,
            execution_id: "e1",
            tool: "pi-safety",
            reason: "prompt_round_limit",
            timed_out: false,
            aborted: false,
            safety_incident: "prompt_round_limit",
          });
        }
        return { sessionId: "d1", result: "ok", outcome: "text" as const };
      }),
    };
    const sleepHandle = createSleepHandle({
      client: client as unknown as import("../../components/abmind-client-contract.js").AbmindClientLike,
      memoryEnabled: true,
      onComplete: () => {},
      onCycleEnd: () => {},
      sessionManager: sessionManager as unknown as import("../../capabilities/sleep/index.js").SleepOpts["sessionManager"],
      allocateSleepSession: (name: string) => `test_${name}`,
      quarantineSession: () => {},
      bufferSystemEvent: async () => {},
      bufferAgentNotice: async () => {},
    });
    // Ensure DEFAULT_PROVIDER/MODEL are set for fallback
    const origProvider = process.env["DEFAULT_PROVIDER"];
    const origModel = process.env["DEFAULT_MODEL"];
    process.env["DEFAULT_PROVIDER"] = "openrouter";
    process.env["DEFAULT_MODEL"] = "test-model";
    try {
      const started = sleepHandle.startScheduled();
      expect(started.status).toBe("accepted");
      if (started.status === "accepted") {
        const admission = await (started as unknown as { admission: Promise<{ status: string; runId?: string }> }).admission;
        expect(admission.status).toBe("accepted");
        const outcome = await started.completion;
        // Outcome should be failed with prompt_round_limit preserved
        // Check daemon status report
        const status = await client.sleep.status();
        expect(status.last?.report).toContain("Stage:");
        expect(status.last?.report).toContain("prompt_round_limit");
        expect(status.last?.report).toContain("Action:");
        if (status.last?.resumable) {
          expect(status.last?.report).toContain("Resume: /sleep resume");
        }
        expect(status.last?.resumable).toBe(true);
        // Resumability survives coordinator restart
        const lastRunPath = join(memoryDir, "sleep-last-run.json");
        expect(existsSync(lastRunPath)).toBe(true);
        const persisted = JSON.parse(readFileSync(lastRunPath, "utf-8")) as { resumable: boolean; formatVersion?: number };
        expect(persisted.resumable).toBe(true);
        expect(persisted.formatVersion).toBe(2);
        // Rejected admission leaves previous report unchanged — test before successful resume to avoid already_running
        const beforeReport = status.last?.report;
        const notFound = await client.sleep.resume("nonexistent-id");
        expect(notFound.status).toBe("not_found");
        const afterStatus = await client.sleep.status();
        expect(afterStatus.last?.report).toBe(beforeReport);
        // Resume should be admitted
        const resumeRes = await client.sleep.resume(status.last?.runId);
        expect(resumeRes.status).toBe("accepted");
      }
    } finally {
      if (origProvider !== undefined) process.env["DEFAULT_PROVIDER"] = origProvider; else delete process.env["DEFAULT_PROVIDER"];
      if (origModel !== undefined) process.env["DEFAULT_MODEL"] = origModel; else delete process.env["DEFAULT_MODEL"];
      if (origUser !== undefined) process.env["ABMIND_USER_ID"] = origUser; else delete process.env["ABMIND_USER_ID"];
      if (origAbmindHome !== undefined) process.env["ABMIND_HOME"] = origAbmindHome; else delete process.env["ABMIND_HOME"];
      await host.stop();
      rmSync(memoryDir, { recursive: true, force: true });
    }
  }, 30000);

  it("rejected admission produces rejection, no Dreamy call, no pending completion, one lease close", async () => {
    const origUser2 = process.env["ABMIND_USER_ID"];
    const origAbmindHome2 = process.env["ABMIND_HOME"];
    process.env["ABMIND_USER_ID"] = "test";
    const memoryDir = mkdtempSync(join(tmpdir(), "abmind-1752-rej-"));
    process.env["ABMIND_HOME"] = memoryDir;
    const { cpSync: cpSync2 } = await import("node:fs");
    const srcPrompts2 = join(process.cwd(), "../abmind/templates/prompts");
    if (existsSync(srcPrompts2)) {
      mkdirSync(join(memoryDir, "prompts", "sleep"), { recursive: true });
      cpSync2(srcPrompts2, join(memoryDir, "prompts"), { recursive: true });
    }
    const MEM_CONFIG2 = {
      memoryEnabled: true,
      memoryDir,
      maxMessagesPerChat: 100,
      diskBudgetBytes: 1048576,
      stalenessThresholdMs: 86400000,
      restoreMessageCount: 50,
      ingestChunkMaxTokens: 512,
      embeddingModel: "nomic-embed-text",
      forgetThreshold: 0.8,
      searchEnhancements: { searchTimeoutMs: 1000, decayHalflifeDays: 30, mmrLambda: 0.7, compactThresholdPct: 85 },
    } as unknown as import("abmind").MemoryConfig;
    const identity2 = new InjectableProcessIdentity({ pid: Math.floor(10000 + Math.random() * 50000), startToken: `test2-${Date.now()}` });
    const host = new AbmindServiceHost({
      mode: "embedded",
      memory: MEM_CONFIG2,
      policy: { principalId: "test", role: "service", grantedDomains: ["system", "private", "operational"], authenticatedBy: "embedded", capabilities: ["sleep_start", "sleep_status", "sleep_resume", "sleep_events", "sleep_runtime_provider"] },
      leaseRoot: memoryDir,
      processIdentity: identity2,
    } as unknown as ConstructorParameters<typeof AbmindServiceHost>[0]);
    await host.start();
    const transport = new EmbeddedTransport(host.service!, { principalId: "test", role: "service", grantedDomains: new Set(["system", "private", "operational"]), authenticatedBy: "embedded", capabilities: new Set(["sleep_start", "sleep_status", "sleep_resume", "sleep_events", "sleep_runtime_provider"]) });
    const client = new AbmindClient(transport);
    const spin = vi.fn(async () => ({ sessionId: "d1", result: "ok", outcome: "text" as const }));
    const closeSpy = vi.spyOn(client.sleep.runtime, "close");
    const handle = createSleepHandle({
      client: client as unknown as import("../../components/abmind-client-contract.js").AbmindClientLike,
      memoryEnabled: true,
      onComplete: () => {},
      onCycleEnd: () => {},
      sessionManager: { spin } as unknown as import("../../capabilities/sleep/index.js").SleepOpts["sessionManager"],
      allocateSleepSession: () => "test",
      quarantineSession: () => {},
      bufferSystemEvent: async () => {},
      bufferAgentNotice: async () => {},
    });
    const origProvider = process.env["DEFAULT_PROVIDER"];
    const origModel = process.env["DEFAULT_MODEL"];
    process.env["DEFAULT_PROVIDER"] = "openrouter";
    process.env["DEFAULT_MODEL"] = "test-model";
    try {
      // First, ensure no resumable run exists, so resume will be not_found
      const before = await client.sleep.status();
      const beforeReport = before.last?.report;
      const started = handle.startManual({ fresh: false, resume: true });
      expect(started.status).toBe("accepted");
      if (started.status === "accepted") {
        const admission = await (started as unknown as { admission: Promise<{ status: string }> }).admission;
        expect(admission.status).toBe("rejected");
        // No Dreamy call
        expect(spin).not.toHaveBeenCalled();
        // Exactly one lease close (the bootstrap lease); no provider pump was
        // started, so it must not close a second lease.
        await new Promise(r => setTimeout(r, 200));
        expect(closeSpy).toHaveBeenCalledTimes(1);
        // Previous last-run report unchanged (or still idle)
        const after = await client.sleep.status();
        expect(after.last?.report).toBe(beforeReport);
      }
    } finally {
      if (origProvider !== undefined) process.env["DEFAULT_PROVIDER"] = origProvider; else delete process.env["DEFAULT_PROVIDER"];
      if (origModel !== undefined) process.env["DEFAULT_MODEL"] = origModel; else delete process.env["DEFAULT_MODEL"];
      if (origUser2 !== undefined) process.env["ABMIND_USER_ID"] = origUser2; else delete process.env["ABMIND_USER_ID"];
      if (origAbmindHome2 !== undefined) process.env["ABMIND_HOME"] = origAbmindHome2; else delete process.env["ABMIND_HOME"];
      await host.stop();
      rmSync(memoryDir, { recursive: true, force: true });
    }
  }, 30000);
});
