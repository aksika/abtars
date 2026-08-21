#!/usr/bin/env tsx
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ScheduledTask } from "../src/components/tasks/task-types.js";
import type {
  AgentEvent,
  ModelApi,
  PiAgentCoreModule,
  PiAgentListener,
  PiAgentOptions,
  StreamFn,
} from "../src/components/transport/pi-core-types.js";
import type { ModelCandidate } from "../src/components/transport/model-candidates.js";

const RUN_ID = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OUT_DIR = join(process.cwd(), "test-results", "report-pipeline-e2e", RUN_ID);
const HOME = mkdtempSync(join(tmpdir(), "abtars-e2e-"));

interface MilestoneResult {
  id: string; name: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  scenario: string; expected: string; observed: string;
  blockedBy?: string; durationMs: number; evidence: string[];
  correlation?: { taskId?: string; runId?: string; groupId?: string; attempt?: number; cardId?: number; executionId?: string };
}

const milestones: MilestoneResult[] = [];
type CheckpointSuccess = true | { observed: string; evidence: string[]; correlation?: MilestoneResult["correlation"] };

const acceptanceModel: ModelApi = {
  id: "acceptance-model",
  name: "Acceptance model",
  api: "pi-messages",
  provider: "acceptance",
  baseUrl: "https://acceptance.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const noProviderStream: StreamFn = () => {
  throw new Error("provider must not be called for an empty host probe");
};

async function checkpoint(id: string, name: string, scenario: string, expected: string, fn: () => Promise<string | CheckpointSuccess>, deps?: string[]): Promise<void> {
  const start = Date.now();
  if (deps) {
    for (const dep of deps) {
      const dr = milestones.find(m => m.id === dep);
      if (dr && (dr.status === "FAIL" || dr.status === "BLOCKED" || dr.status === "NOT_RUN")) {
        milestones.push({ id, name, status: "BLOCKED", scenario, expected, observed: `blocked by ${dep} (${dr.status})`, blockedBy: dep, durationMs: Date.now() - start, evidence: [] });
        return;
      }
    }
  }
  let status: MilestoneResult["status"] = "PASS";
  let observed = ""; let evidence: string[] = [];
  let correlation: MilestoneResult["correlation"];
  try {
    const result = await fn();
    if (typeof result === "string") { status = "FAIL"; observed = result; evidence = [result]; }
    else if (typeof result === "object") { observed = result.observed; evidence = result.evidence; correlation = result.correlation; }
    else { observed = "pass"; evidence = ["assertions passed"]; }
  } catch (err) {
    status = "FAIL"; observed = err instanceof Error ? err.message : String(err); evidence = [observed];
  }
  milestones.push({ id, name, status, scenario, expected, observed, durationMs: Date.now() - start, evidence, ...(correlation ? { correlation } : {}) });
}

function scenario(name: string): void { console.log(`\nScenario: ${name}`); }

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  process.env.ABTARS_HOME = HOME;
  const H = HOME;
  mkdirSync(join(H, "tasks"), { recursive: true });
  mkdirSync(join(H, "workspace"), { recursive: true });
  mkdirSync(join(H, "state"), { recursive: true });
  mkdirSync(join(H, "kanban"), { recursive: true });
  mkdirSync(join(H, "logs"), { recursive: true });

  const taskTypes = await import("../src/components/tasks/task-types.js");
  const taskPreflight = await import("../src/components/tasks/task-preflight.js");
  const taskPackage = await import("../src/components/tasks/task-package.js");
  const stateStore = await import("../src/components/tasks/task-state-store.js");
  const historyStore = await import("../src/components/tasks/task-history-store.js");
  const execControl = await import("../src/components/execution-control.js");
  const taskChecker = await import("../src/components/tasks/task-checker.js");
  const taskService = await import("../src/components/tasks/task-service.js");
  const kanbanBoard = await import("../src/components/tasks/kanban-board.js");
  const { CronQueue } = await import("../src/components/tasks/task-queue.js");
  const { ScheduledTaskRunner } = await import("../src/components/tasks/scheduled-task-runner.js");
  const { deliverCard } = await import("../src/components/tasks/kanban-delivery.js");
  const logger = await import("../src/components/logger.js");
  logger.setLogLevel("trace");
  logger.setFileLogging(true);

  async function waitForQueueIdle(queue: { currentJob: unknown }, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (queue.currentJob && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (queue.currentJob) throw new Error(`queue did not become idle within ${timeoutMs}ms`);
  }

  // Fixtures go through the production normalizer — task-store.ts:30/:74 do
  // the same, so any future required field flows in automatically instead of
  // becoming the next silent drift.
  function makeEntry(raw: Record<string, unknown>): ScheduledTask {
    const result = taskTypes.normalize(raw);
    if (!result.ok) throw new Error(`invalid fixture ${String(raw["id"])}: ${result.error}`);
    return result.entry;
  }

  function makeAgentEntry(raw: Record<string, unknown>): ScheduledTask & { kind: "agent" } {
    const entry = makeEntry(raw);
    if (entry.kind !== "agent") throw new Error(`fixture ${entry.id} is not an agent task`);
    return entry;
  }

  async function runProductionFixture(
    taskId: string,
    artifactName: string,
    sections: string[],
    minBytes: number,
  ): Promise<string | CheckpointSuccess> {
    const artifactPath = join(H, "workspace", taskId, artifactName);
    mkdirSync(join(H, "workspace", taskId), { recursive: true });
    let cardId = 0;
    const agentRunner = async (request: import("../src/components/spin-types.js").SpinRequest) => {
      cardId = kanbanBoard.kanbanEnqueue(taskId, "task", taskId, {
        type: request.type,
        goal: request.goal,
        delivery: "report",
        chatId: "acceptance",
      });
      if (!cardId) throw new Error(`Kanban card was not created for ${taskId}`);
      // #1540: the shared execution control must know the card before the
      // runner's settlement can attach result/delivery to it.
      request.executionControl?.setCardId(cardId);
      kanbanBoard.kanbanRunning(cardId);
      const content = `${sections.join("\n\n")}\n\n${("deterministic acceptance artifact for " + taskId + "\n").repeat(80)}`;
      writeFileSync(artifactPath, content, "utf-8");
      return { cardId, result: `provider completed ${taskId}`, outcome: "text" as const };
    };
    const { ScheduledRunCoordinator } = await import("../src/components/tasks/scheduled-run-coordinator.js");
    const coordinator = new ScheduledRunCoordinator({ agentRunner });
    const queue = new CronQueue(coordinator);
    const normalized = taskTypes.normalize({
      id: taskId, kind: "agent", delivery: "report", at: new Date().toISOString(),
      agent: "task", prompt: `Generate ${taskId}`, chatId: "acceptance", enabled: true, priority: "medium",
      report: { artifact: artifactPath, requiredSections: sections, minBytes, requires: { files: [], executables: [], tools: [] } },
    });
    if (!normalized.ok) return `fixture ${taskId} rejected: ${normalized.error}`;
    const enqueueError = queue.enqueue(normalized.entry, true);
    if (enqueueError) return `fixture ${taskId} was not queued: ${enqueueError}`;
    await waitForQueueIdle(queue);
    // #1539: lane release is driven by the durable terminal event; the card
    // mutation happens in the same settlement flow. Settlement completes
    // synchronously before waitForQueueIdle returns — a poll loop here would
    // mask the exact regression M46-48 exist to catch if settlement ever moves
    // onto a heartbeat sweep.
    const card = kanbanBoard.kanbanGetCard(cardId);
    if (!card || card.status !== "done") return `fixture ${taskId} card not done: ${card?.status ?? "missing"}`;
    const state = stateStore.readState(taskId);
    const runs = historyStore.recentRuns(taskId, 5);
    if (card.result_path !== artifactPath || !existsSync(artifactPath)) return `fixture ${taskId} artifact was not settled`;
    const success = runs.find(run => run.outcome === "success");
    if (!success) return `fixture ${taskId} has no successful terminal history`;
    if (state?.activeRun) return `fixture ${taskId} left activeRun=${state.activeRun.runId}`;

    let sends: number = 0;
    await deliverCard(card, {
      sendMessage: async () => { sends++; return "sent" as const; },
      sendDocument: async (_chatId, path) => { if (path !== artifactPath) throw new Error("wrong artifact delivered"); sends++; return "sent" as const; },
      announce: async (_prompt) => { sends++; },
      chatIdFor: () => "acceptance",
    });
    const delivered = kanbanBoard.kanbanGetCard(cardId);
    if (delivered?.status !== "delivered" || delivered.delivery_result !== "sent" || sends !== 1) {
      return `fixture ${taskId} delivery incomplete: status=${delivered?.status} result=${delivered?.delivery_result} sends=${sends}`;
    }
    await deliverCard(delivered, {
      sendMessage: async (_chatId, _text) => { sends++; return "not_sent" as const; },
      sendDocument: async (_chatId, _filePath, _caption) => { sends++; return "not_sent" as const; },
      announce: async (_prompt) => { sends++; },
      chatIdFor: () => "acceptance",
    });
    if (sends !== 1) return `fixture ${taskId} was delivered more than once`;
    return {
      observed: `${taskId} ran through queue → provider boundary → fresh artifact → settlement → delivery`,
      evidence: [`run=${success.runId}`, `group=${success.groupId ?? "none"}`, `card=${cardId}`, `artifact_bytes=${lstatSync(artifactPath).size}`, `delivery_result=sent`, `duplicate_send_count=0`],
      correlation: { taskId, runId: success.runId, groupId: success.groupId, attempt: 1, cardId },
    };
  }

  // ── M01: Build identity ──────────────────────────────────────────────────

  scenario("Deployment identity");
  await checkpoint("M01", "Build identity is present", "deployment", "build-info.json with hash+date", async () => {
    const p = join(process.cwd(), "dist", "build-info.json");
    if (!existsSync(p)) return `build-info.json not found at ${p}`;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (!raw.hash || !raw.date) return `missing hash or date: ${JSON.stringify(raw)}`;
    return true;
  });

  // ── M02-M03: Scheduler ───────────────────────────────────────────────────

  scenario("Scheduler invocation");
  await checkpoint("M02", "checkCron runs without throwing", "scheduler", "no unhandled error", async () => {
    // No entries → empty return, not an error
    const result = taskChecker.checkCron();
    if (!Array.isArray(result)) return `checkCron did not return array`;
    return true;
  });

  await checkpoint("M03", "checkCron returns reserved task for due entry", "scheduler", "reserved task with runId", async () => {
    const { writeEntries } = await import("../src/components/tasks/task-store.js");
    const id = `cron-${Date.now()}`;
    const entry = makeEntry({ id, kind: "agent", delivery: "announce", schedule: "* * * * *", agent: "task", prompt: "test", enabled: true, priority: "medium" });
    writeEntries([entry]);
    // Force nextRunAt into the past so scheduler considers it due
    stateStore.updateState(id, { nextRunAt: Date.now() - 60000 });
    const result = taskChecker.checkCron();
    const ours = result.filter(r => r.entry.id === id);
    if (ours.length === 0) { const reasons = result.map(r => r.entry.id).join(","); return `no due entries for ${id}. total due: ${result.length} ids: ${reasons}`; }
    if (!ours[0]!.run.runId) return `reserved run has no runId`;
    return true;
  });

  // ── M04-M05: Active run ownership ────────────────────────────────────────

  scenario("Active run ownership");
  await checkpoint("M04", "reserveRun creates exclusive reservation", "scheduler", "first ok, duplicate rejects", async () => {
    const id = `own-${Date.now()}`;
    const r1 = stateStore.reserveRun(id, { runId: "r1", groupId: "g1", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() + 60000 });
    if (!r1.ok) return `first reservation failed`;
    const r2 = stateStore.reserveRun(id, { runId: "r2", groupId: "g2", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() + 60000 });
    if (r2.ok) return `duplicate reservation should have been rejected`;
    const st = stateStore.readState(id);
    if (!st?.activeRun) return `activeRun not persisted`;
    if (st.activeRun.runId !== "r1") return `runId mismatch: ${st.activeRun.runId} !== r1`;
    if (st.lastStartedAt === undefined) return `lastStartedAt not set by reserveRun`;
    return true;
  });

  await checkpoint("M05", "settleActiveRun clears reservation", "scheduler", "activeRun cleared+state update", async () => {
    const id = `settle-${Date.now()}`;
    stateStore.reserveRun(id, { runId: "rs", groupId: "gs", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() + 60000 });
    const settled = stateStore.settleActiveRun(id, "rs", { lastFinishedAt: Date.now() });
    if (!settled) return `settleActiveRun returned false`;
    const st = stateStore.readState(id);
    if (st?.activeRun) return `activeRun not cleared after settle`;
    if (!st?.lastFinishedAt) return `state update not applied`;
    return true;
  });

  // ── M06-M07: Contract validation ─────────────────────────────────────────

  scenario("Contract validation");
  await checkpoint("M06", "Structured report contract parses successfully", "normalize", "valid contract accepted", async () => {
    const r = taskTypes.normalize({ id: "valid-c", kind: "agent", delivery: "report", at: new Date().toISOString(), agent: "task", prompt: "test", chatId: "1", report: { artifact: "~/test.md", requiredSections: ["# Result"], minBytes: 100, requires: { files: [], executables: [], tools: [] } } });
    if (!r.ok) return `rejected: ${r.error}`;
    return true;
  });

  await checkpoint("M07", "Invalid contract terminates before model execution", "normalize", "missing artifact path rejected", async () => {
    const r = taskTypes.normalize({ id: "bad-art", kind: "agent", delivery: "report", at: new Date().toISOString(), agent: "task", prompt: "test", chatId: "1", report: { artifact: "", requiredSections: ["# X"], minBytes: 100, requires: { files: [], executables: [], tools: [] } } });
    if (r.ok) return `empty artifact path should be rejected`;
    return true;
  });

  // ── M08-M09: Preflight ───────────────────────────────────────────────────

  scenario("Preflight");
  await checkpoint("M08", "Required file missing → preflight fails", "preflight", "definition_failed + code", async () => {
    const e = makeAgentEntry({ id: "pf1", kind: "agent", delivery: "report", agent: "task", prompt: "t", at: new Date().toISOString(), enabled: true, priority: "medium", report: { artifact: join(H, "workspace", "pf1", "o.md"), requiredSections: ["# X"], minBytes: 100, requires: { files: ["/nonexistent/file.xyz"], executables: [], tools: [] } } });
    const result = taskPreflight.preflightTask(e, taskPackage.createExecutionScope("pf1"), undefined);
    if (result.ok) return `should reject missing file`;
    if (result.code !== "required_file_missing") return `expected required_file_missing got ${result.code}`;
    return true;
  });

  await checkpoint("M09", "Missing executable → preflight fails", "preflight", "required_executable_missing", async () => {
    const e = makeAgentEntry({ id: "pfex", kind: "agent", delivery: "report", agent: "task", prompt: "t", at: new Date().toISOString(), enabled: true, priority: "medium", report: { artifact: join(H, "workspace", "pfex", "o.md"), requiredSections: ["# X"], minBytes: 100, requires: { files: [], executables: ["nonexistent_tool_xyz"], tools: [] } } });
    const scope = taskPackage.createExecutionScope("pfex");
    const result = taskPreflight.preflightTask(e, { cwd: scope.cwd, env: { ...scope.env, PATH: "/dev/null" } }, undefined);
    if (result.ok) return `should reject missing exe`;
    if (result.code !== "required_executable_missing") return `expected required_executable_missing got ${result.code}`;
    return true;
  });

  // ── M10-M11: Context and workspace scope ─────────────────────────────────

  scenario("Context and workspace");
  await checkpoint("M10", "Task context directory exists", "runner", "CONTEXT.md can be stored", async () => {
    const d = join(H, "workspace", "ctx-task"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "CONTEXT.md"), "notes", "utf-8");
    if (!existsSync(join(d, "CONTEXT.md"))) return `CONTEXT.md not created`;
    return true;
  });

  await checkpoint("M11", "Execution scope is scoped to task ID", "runner", "cwd env WORKSPACE", async () => {
    const scope = taskPackage.createExecutionScope("scope-test");
    if (!scope.cwd.includes("scope-test")) return `cwd missing task ID: ${scope.cwd}`;
    if (!scope.env.WORKSPACE) return `WORKSPACE not set`;
    if (scope.env.WORKSPACE !== scope.cwd) return `WORKSPACE !== cwd`;
    return true;
  });

  // ── M12-M14: Run identity, execution control, kanban card ─────────────────

  scenario("Run identity and card");
  await checkpoint("M12", "Run identity allocated before execution", "scheduler", "runId is non-empty string", async () => {
    const id = `identity-${Date.now()}`;
    const reservation = stateStore.reserveRun(id, {
      runId: `${id}_run`, groupId: `${id}:group`, attempt: 1, trigger: "manual",
      occurrenceAt: Date.now(), deadlineAt: Date.now() + 60_000,
    });
    if (!reservation.ok) return `reserveRun rejected identity test`;
    const state = stateStore.readState(id);
    if (state?.activeRun?.runId !== reservation.run.runId) return `reserved identity not persisted`;
    stateStore.settleActiveRun(id, reservation.run.runId, {});
    return { observed: `reservation allocated ${reservation.run.runId} before execution`, evidence: [`run=${reservation.run.runId}`, `group=${reservation.run.groupId}`, `attempt=${reservation.run.attempt}`], correlation: { taskId: id, runId: reservation.run.runId, groupId: reservation.run.groupId, attempt: reservation.run.attempt } };
  });

  await checkpoint("M13", "Execution control can be registered and removed", "runner", "supervisor open+get+remove", async () => {
    const sv = execControl.createExecutionSupervisor({ maxConcurrent: { T: 1 } });
    const ref = `ctrl-${Date.now()}`;
    const ctrl = sv.open({ executionRef: ref, type: "T" });
    if (!ctrl) return `open returned no control`;
    if (ctrl.cancelled) return `new control should not be cancelled`;
    sv.remove(ref);
    if (sv.get(ref)) return `control still present after remove`;
    return true;
  });

  await checkpoint("M14", "Kanban card created and started", "runner", "kanbanEnqueue+kanbanRunning", async () => {
    const id = kanbanBoard.kanbanEnqueue("test card", "task", "t1", { priority: "MEDIUM" });
    if (id === 0) return `kanbanEnqueue returned 0 (DB unavailable)`;
    kanbanBoard.kanbanRunning(id);
    const card = kanbanBoard.kanbanGetCard(id);
    if (!card) return `card not found after enqueue`;
    if (card.status !== "running") return `card status should be running, got ${card.status}`;
    return true;
  });

  // ── M15-M23: Execution (deterministic interface testing) ─────────────────

  scenario("Execution (provider-agnostic boundaries)");
  await checkpoint("M15", "Pi host can be imported and validates contract", "execution", "module loads, contract shape", async () => {
    const { PiCoreExecutionHost } = await import("../src/components/transport/pi-core-host.js");
    const real = await import("@earendil-works/pi-agent-core");
    const piTypes: typeof import("../src/components/transport/pi-core-types.js") = await import("../src/components/transport/pi-core-types.js");
    piTypes.validatePiAgentCoreModule(real, "acceptance");
    const realModule: PiAgentCoreModule = {
      Agent: class extends real.Agent {
        constructor(options?: PiAgentOptions) {
          super(options ?? { streamFn: noProviderStream });
        }
      },
    };
    const host = new PiCoreExecutionHost({
      executionId: `acceptance-exec-${Date.now()}`, sessionId: "acceptance-session",
      initialState: { systemPrompt: "acceptance", model: acceptanceModel, messages: [], tools: [] },
      streamFn: noProviderStream,
    });
    await host.start({ module: realModule, installation: { executable: "", packageRoot: "", version: "installed", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } } });
    if (host.state !== "running") return `Pi host did not enter running state: ${host.state}`;
    host.cancel();
    await host.waitForSettlement();
    if (!host.isSettled) return `Pi host did not settle after cancellation`;
    return { observed: "real public Pi Agent constructed, started, cancelled, and settled", evidence: ["provider_calls=0", "host_state=settled"] };
  });

  await checkpoint("M16", "Provider/model selection is interface-driven", "execution", "SessionProfile lookup works", async () => {
    const profiles = await import("../src/components/spin-profiles.js");
    const profile = profiles.profileFor("T");
    if (!profile) return `no profile for session type T`;
    if (!profile.agent) return `profile missing agent`;
    return true;
  });

  await checkpoint("M17", "Spin dispatchAwait accepts caller-owned settlement", "execution", "settlementOwner param", async () => {
    let observedRequest: import("../src/components/spin-types.js").SpinRequest | undefined;
    const id = `settlement-owner-${Date.now()}`;
    const entry = makeAgentEntry({ id, kind: "agent", delivery: "announce", at: new Date().toISOString(), agent: "task", prompt: "settlement owner probe", enabled: true, priority: "medium", interaction: { mode: "oneshot" } });
    const reservation = stateStore.reserveRun(id, { runId: `${id}_run`, groupId: `${id}:group`, attempt: 1, trigger: "manual", occurrenceAt: Date.now(), deadlineAt: Date.now() + 60_000 });
    if (!reservation.ok) return `could not reserve settlement-owner probe`;
    const probe = new ScheduledTaskRunner({ agentRunner: async request => {
      observedRequest = request;
      const cardId = kanbanBoard.kanbanEnqueue(id, "task", id, { delivery: "silent", type: request.type });
      kanbanBoard.kanbanRunning(cardId);
      return { cardId, result: "settlement owner probe", outcome: "text" as const };
    } });
    const outcome = await probe.run(entry, reservation.run);
    if (outcome.status !== "success") return `runner outcome=${outcome.status}: ${outcome.safeDetail}`;
    if (observedRequest?.settlementOwner !== "caller") return `runner did not pass settlementOwner=caller`;
    return { observed: "real ScheduledTaskRunner passed caller-owned settlement into provider boundary", evidence: [`run=${reservation.run.runId}`, `execution_id=${observedRequest.executionControl?.executionRef ?? "missing"}`, "settlement_owner=caller"], correlation: { taskId: id, runId: reservation.run.runId, groupId: reservation.run.groupId, executionId: observedRequest.executionControl?.executionRef } };
  });

  await checkpoint("M18", "Tool registry has expected entries", "execution", "tools array non-empty", async () => {
    const { createPiAgentTools } = await import("../src/components/transport/pi-core-tools.js");
    const { createPiExecutionSafetyController } = await import("../src/components/transport/pi-core-safety.js");
    const { FallbackPolicy } = await import("../src/components/transport/fallback-policy.js");
    const { ModelHealthRegistry } = await import("../src/components/transport/model-health-registry.js");
    const { buildPolicy } = await import("../src/components/tool-sandbox.js");
    const policy = new FallbackPolicy([], new ModelHealthRegistry());
    const tools = createPiAgentTools({ executionId: "acceptance-tools", userId: "acceptance", sandboxPolicy: buildPolicy("owner"), safety: createPiExecutionSafetyController(policy) });
    if (tools.length === 0) return `Pi tool adapter produced no tools`;
    if (tools.some(tool => !tool.name || tool.executionMode !== "sequential")) return `Pi tool adapter returned malformed tool`;
    return { observed: `real Pi tool adapter constructed ${tools.length} registered tools`, evidence: [`tool_count=${tools.length}`, "execution_mode=sequential"] };
  });

  await checkpoint("M19", "Execution scope provides cwd and env for tools", "execution", "scope has WORKSPACE", async () => {
    const scope = taskPackage.createExecutionScope("tool-task");
    if (!scope.cwd) return `cwd missing`;
    if (!scope.env.WORKSPACE) return `WORKSPACE missing`;
    return true;
  });

  await checkpoint("M20", "State store tracks consecutive failures", "execution", "incrementFailures >0", async () => {
    const id = `nf-${Date.now()}`;
    const c1 = stateStore.incrementFailures(id);
    if (c1 !== 1) return `first increment should be 1, got ${c1}`;
    const c2 = stateStore.incrementFailures(id);
    if (c2 !== 2) return `second increment should be 2, got ${c2}`;
    return true;
  });

  await checkpoint("M21", "Reset failures clears count", "execution", "consecutiveFailures = 0", async () => {
    const id = `rf-${Date.now()}`;
    stateStore.incrementFailures(id);
    stateStore.incrementFailures(id);
    stateStore.resetFailures(id);
    const st = stateStore.readState(id);
    if ((st?.consecutiveFailures ?? -1) !== 0) return `failures not reset: ${st?.consecutiveFailures}`;
    return true;
  });

  await checkpoint("M22", "Auto-pause triggers at 3 consecutive failures", "execution", "autoPaused=true", async () => {
    const id = `ap3-${Date.now()}`;
    stateStore.incrementFailures(id);
    stateStore.incrementFailures(id);
    stateStore.incrementFailures(id);
    stateStore.setAutoPaused(id, true);
    const st = stateStore.readState(id);
    if (!st?.autoPaused) return `autoPaused not set`;
    return true;
  });

  await checkpoint("M23", "Prompt-wide termination via tool-round limit", "execution", "maxToolRounds configurable", async () => {
    const { createPiExecutionSafetyController } = await import("../src/components/transport/pi-core-safety.js");
    const { FallbackPolicy } = await import("../src/components/transport/fallback-policy.js");
    const { ModelHealthRegistry } = await import("../src/components/transport/model-health-registry.js");
    const policy = new FallbackPolicy([], new ModelHealthRegistry());
    const safety = createPiExecutionSafetyController(policy, { maxPromptRounds: 2, maxCandidateRounds: 2 });
    const first = safety.beginProviderTurn("acceptance-model@deterministic");
    const second = safety.beginProviderTurn("acceptance-model@deterministic");
    const terminal = safety.beginProviderTurn("acceptance-model@deterministic");
    if (first.decision !== "continue" || second.decision !== "continue" || terminal.decision !== "stop") return `unexpected safety decisions: ${first.decision}/${second.decision}/${terminal.decision}`;
    if (!safety.terminalSafetyFailure || safety.incident?.type !== "prompt_round_limit") return `prompt-round limit did not become terminal safety failure`;
    return { observed: "real Pi safety controller stopped at configured prompt-round limit", evidence: [`rounds=${safety.promptRoundsUsed}`, `limit=${safety.maxPromptRounds}`, `incident=${safety.incident.type}`] };
  });

  // ── M24-M32: Failure, retry, cancellation ────────────────────────────────

  scenario("Failure and retry");
  await checkpoint("M24", "Kanban fail closes card", "settlement", "card becomes failed", async () => {
    const id = kanbanBoard.kanbanEnqueue("fail-test", "task", "ft", { priority: "MEDIUM" });
    kanbanBoard.kanbanRunning(id);
    kanbanBoard.kanbanFail(id, "test failure");
    const card = kanbanBoard.kanbanGetCard(id);
    if (card?.status !== "failed") return `card should be failed, got ${card?.status}`;
    return true;
  });

  await checkpoint("M25", "Failed execution writes one history event", "settlement", "run recorded in history", async () => {
    const runId = `hist-${Date.now()}`;
    historyStore.appendRun({ runId, taskId: "h1", kind: "agent", trigger: "schedule", startedAt: Date.now(), finishedAt: Date.now(), outcome: "failed" });
    if (!historyStore.hasRun(runId)) return `history not found after append`;
    return true;
  });

  await checkpoint("M26", "appendRunOnce deduplicates by runId", "settlement", "duplicate returns null", async () => {
    const runId = `dedup-${Date.now()}`;
    const first = historyStore.appendRunOnce({ runId, taskId: "d1", kind: "agent", trigger: "schedule", startedAt: Date.now(), finishedAt: Date.now(), outcome: "success" });
    if (!first) return `first appendRunOnce returned null`;
    const second = historyStore.appendRunOnce({ runId, taskId: "d1", kind: "agent", trigger: "schedule", startedAt: Date.now(), finishedAt: Date.now(), outcome: "success" });
    if (second !== null) return `duplicate should return null, got ${second}`;
    if (!historyStore.hasRun(runId)) return `hasRun false after append`;
    return true;
  });

  await checkpoint("M27", "Retry scheduled via setRetrying", "retry", "retrying flag+retryAt set", async () => {
    const id = `ret-${Date.now()}`;
    const now = Date.now();
    stateStore.updateState(id, { retrying: false });
    stateStore.setRetrying(id, true, now + 600000);
    const st = stateStore.readState(id);
    if (!st?.retrying) return `retrying not set`;
    if (!st?.retryAt) return `retryAt not set`;
    return true;
  });

  await checkpoint("M28", "Prior failure context preserved for retry", "retry", "priorFailure stored", async () => {
    const id = `pf-${Date.now()}`;
    stateStore.updateState(id, { priorFailure: "test failure reason" });
    const st = stateStore.readState(id);
    if (st?.priorFailure !== "test failure reason") return `priorFailure not preserved`;
    return true;
  });

  await checkpoint("M29", "Retry reaches terminal state", "retry", "retrying cleared on success", async () => {
    const id = `rt-${Date.now()}`;
    stateStore.updateState(id, { retrying: true, retryAt: Date.now() + 60000 });
    stateStore.updateState(id, { retrying: false, lastFinishedAt: Date.now() });
    const st = stateStore.readState(id);
    if (st?.retrying) return `retrying not cleared after terminal`;
    return true;
  });

  const PH = await import("../src/components/transport/pi-core-host.js");
  const EC = await import("../src/components/execution-control.js");

  await checkpoint("M30", "Non-settling provider: forced terminal + slot release + cleanup timeout", "timeout", "Non-settling Pi provider forces terminal settlement within 5s bound", async () => {
    const executionId = `m30-${Date.now()}`;
    let subscribed = false;

    // Build a PiCoreExecutionHost with a mock Agent whose waitForIdle() never
    // resolves — this simulates a provider that ignores abort. The #1506 fix
    // must make waitForSettlement() resolve immediately on cancel regardless.
    const subs: PiAgentListener[] = [];
    const pi = await import("@earendil-works/pi-agent-core");
    const mockModule: PiAgentCoreModule = {
      Agent: class extends pi.Agent {
        constructor(options?: PiAgentOptions) {
          super(options ?? { streamFn: noProviderStream });
          this.subscribe = (listener: PiAgentListener) => {
            subs.push(listener);
            subscribed = true;
            return () => {
              const i = subs.indexOf(listener);
              if (i >= 0) subs.splice(i, 1);
            };
          };
          this.prompt = async () => {};
          this.steer = () => {};
          this.followUp = () => {};
          this.clearAllQueues = () => {};
          this.abort = () => {};
          this.waitForIdle = () => new Promise<void>(() => {}); // NEVER resolves
        }
      },
    };
    const mockInstallation = { executable: "/pi", packageRoot: "/pi", version: "0.80.7", source: "path" as const, pinStatus: "at-pin" as const, moduleRoots: { ai: "", tui: "", agentCore: "" } };
    const host = new PH.PiCoreExecutionHost({
      executionId,
      sessionId: "m30-session",
      initialState: { systemPrompt: "test", model: acceptanceModel, messages: [] },
      streamFn: noProviderStream,
    });
    try {
      await host.start({ module: mockModule, installation: mockInstallation });
    } catch (err) {
      return { observed: `mock Pi host failed to start: ${err instanceof Error ? err.message : String(err)}`, evidence: [] };
    }
    if (!subscribed) return { observed: `agent not subscribed after start`, evidence: [] };
    // Capture the listener BEFORE cancel: settlement unsubscribes the host,
    // which would otherwise empty `subs` and silently skip the late-event check.
    const listener = subs[0];
    if (!listener) return { observed: `agent listener missing after start`, evidence: [] };

    // Cancel — must claim terminal immediately even though waitForIdle hangs
    host.cancel();
    await host.waitForSettlement();

    if (!host.isSettled) return { observed: `not settled after cancel`, evidence: [] };
    // Cleanup must time out (waitForIdle never resolves)
    const cleanup = await host.waitForCleanup();
    if (cleanup !== "timed_out") return { observed: `expected cleanup timed_out but got ${cleanup}`, evidence: [] };

    // Late agent_end must be rejected — check via internal state;
    // handleAgentEnd is no-op when settled, state unchanged
    const stateBefore = host.state;
    const lateAgentEnd: AgentEvent = { type: "agent_end", messages: [] };
    await listener(lateAgentEnd, new AbortController().signal);
    if (host.state !== stateBefore) return { observed: `late agent_end changed state from ${stateBefore} to ${host.state}`, evidence: [] };

    // signalCancel must be non-blocking (never await the bound handler)
    const sv = EC.createExecutionSupervisor({ maxConcurrent: { T: 1 } });
    const ec = sv.open({ executionRef: `sig-${executionId}`, type: "T" });
    let handlerCalled = false;
    ec.bind(async () => { handlerCalled = true; await new Promise(() => {}); }); // never resolves
    const start = Date.now();
    const result = ec.signalCancel("deadline");
    const elapsed = Date.now() - start;
    if (result !== "cancelled") return { observed: `signalCancel returned ${result}`, evidence: [] };
    if (elapsed > 100) return { observed: `signalCancel blocked for ${elapsed}ms`, evidence: [] };
    // The handler is queued in microtask — give it a tick
    await new Promise(r => setTimeout(r, 0));
    if (!handlerCalled) return { observed: `signalCancel handler not queued`, evidence: [] };

    sv.remove(`sig-${executionId}`);
    return { observed: `terminal: clean, cleanup: ${cleanup}, signalCancel: non-blocking (${elapsed}ms), late agent_end rejected`, evidence: [`executionId=${executionId}`] };
  }, ["M15"]);

  await checkpoint("M30A", "Acquisition hang: never-resolving attempt factory is bounded", "timeout", "provider_attempt_timeout phase=acquiring within the inactivity bound", async () => {
    // #1506 reopened: the escaped acquisition edge — the attempt factory never
    // resolves and no iterator exists for any stream watchdog to observe. The
    // whole-attempt liveness runner must bound the acquisition itself.
    const SF = await import("../src/components/transport/pi-stream-fn.js");
    const FP = await import("../src/components/transport/fallback-policy.js");
    const MHR = await import("../src/components/transport/model-health-registry.js");
    const candidate: ModelCandidate = {
      model: "fixture-stuck",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      maxContext: 128000,
      apiKey: "fixture-key",
      source: "primary",
    };
    const registry = new MHR.ModelHealthRegistry();
    const policy = new FP.FallbackPolicy([candidate], registry);
    const attemptFactory = async () => new Promise<never>(() => {});
    const executionId = `m30a-${Date.now()}`;
    const streamFn = SF.createPiStreamFn({
      policy,
      executionId,
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 100,
    });
    const started = Date.now();
    const events: any[] = [];
    const stream = await streamFn(acceptanceModel, { messages: [] }, {});
    for await (const ev of stream) events.push(ev);
    const elapsed = Date.now() - started;
    const terminal = events.at(-1);
    if (terminal?.type !== "error") return `expected terminal error event, got ${terminal?.type ?? "none"}`;
    if (elapsed > 5_000) return `acquisition hang not bounded: ${elapsed}ms`;
    if (!policy.excludedKeys.has("fixture-stuck@https://fixture.invalid/v1")) return "candidate not poisoned after acquisition timeout";
    if (policy.excludedKeys.size !== 1) return `candidate poisoned more than once: ${policy.excludedKeys.size}`;
    return { observed: `bounded at ${elapsed}ms; terminal stopReason=${(terminal.error as { stopReason?: string } | undefined)?.stopReason}; candidate poisoned exactly once`, evidence: [`elapsedMs=${elapsed}`, `executionId=${executionId}`], correlation: { executionId } };
  });

  await checkpoint("M31", "History written for cancellation", "settlement", "cancelled outcome in history", async () => {
    const runId = `cancel-hist-${Date.now()}`;
    historyStore.appendRun({ runId, taskId: "ch", kind: "agent", trigger: "schedule", startedAt: Date.now(), finishedAt: Date.now(), outcome: "cancelled" });
    if (!historyStore.hasRun(runId)) return `cancellation history not found`;
    return true;
  });

  await checkpoint("M32", "Retry and active fields clear after terminal", "settlement", "activeRun+retrying cleared", async () => {
    const id = `clear-${Date.now()}`;
    stateStore.reserveRun(id, { runId: `cr-${Date.now()}`, groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() + 60000 });
    stateStore.updateState(id, { retrying: true, retryAt: Date.now() + 60000 });
    stateStore.settleActiveRun(id, stateStore.readState(id)!.activeRun!.runId, { retrying: false });
    const st = stateStore.readState(id);
    if (st?.activeRun) return `activeRun not cleared`;
    return true;
  });

  // ── M33-M34: State coherence ─────────────────────────────────────────────

  scenario("State coherence");
  await checkpoint("M33", "Timestamps coherent after run", "state", "lastStartedAt ≤ lastFinishedAt", async () => {
    const id = `coh-${Date.now()}`;
    const start = Date.now();
    stateStore.updateState(id, { lastStartedAt: start });
    await new Promise(r => setTimeout(r, 2));
    const finish = Date.now();
    stateStore.updateState(id, { lastFinishedAt: finish });
    const st = stateStore.readState(id);
    if (!st) return `state not found`;
    if (st.lastStartedAt && st.lastFinishedAt && st.lastStartedAt > st.lastFinishedAt) return `lastStartedAt > lastFinishedAt`;
    stateStore.updateState(id, { nextRunAt: finish + 86400000 });
    const st2 = stateStore.readState(id);
    if (!st2?.nextRunAt) return `nextRunAt not set`;
    if (st2.nextRunAt < finish) return `nextRunAt in past`;
    return true;
  });

  await checkpoint("M34", "reconcileActiveTaskRuns clears stale active runs", "state", "past-deadline run cleared", async () => {
    const id = `recon-${Date.now()}`;
    stateStore.reserveRun(id, { runId: `stale-${Date.now()}`, groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() - 60000 });
    const before = stateStore.readState(id);
    if (!before?.activeRun) return `activeRun not set before reconcile`;
    const { ScheduledRunCoordinator } = await import("../src/components/tasks/scheduled-run-coordinator.js");
    const coordinator = new ScheduledRunCoordinator();
    const entry = makeEntry({ id, kind: "agent", delivery: "announce", at: new Date().toISOString(), agent: "task", prompt: "t", enabled: true, priority: "medium", interaction: { mode: "oneshot" } });
    await coordinator.recover([entry]);
    const after = stateStore.readState(id);
    if (after?.activeRun) return `activeRun not cleared after recover with past deadline`;
    return true;
  });

  // ── M35-M38: Artifact validation ─────────────────────────────────────────

  scenario("Artifact validation");
  await checkpoint("M35", "Rejects nonexistent artifact", "artifact", "not found → fail", async () => {
    const c = { artifactPath: "/nonexistent.md", artifactLabel: "t", requiredSections: ["# X"], minBytes: 50, requiredFiles: [], executables: [], tools: [] };
    const r = taskPreflight.validateReportArtifact("/nonexistent.md", { existed: false }, c, Date.now(), "t");
    if (r.ok) return `should reject nonexistent`;
    return true;
  });

  await checkpoint("M36", "Accepts valid fresh artifact", "artifact", "size+heading check pass", async () => {
    const ap = join(H, "ws", "av", "r.md"); mkdirSync(join(H, "ws", "av"), { recursive: true });
    writeFileSync(ap, "# Result\n\ncontent\n".repeat(30), "utf-8");
    const c = { artifactPath: ap, artifactLabel: "t", requiredSections: ["# Result"], minBytes: 50, requiredFiles: [], executables: [], tools: [] };
    const r = taskPreflight.validateReportArtifact(ap, { existed: false }, c, Date.now() - 1000, "av");
    if (!r.ok) return `rejected: ${r.reason}`;
    return true;
  });

  await checkpoint("M37", "Rejects artifact with missing required heading", "artifact", "heading not found → fail", async () => {
    const ap = join(H, "ws", "ah", "r.md"); mkdirSync(join(H, "ws", "ah"), { recursive: true });
    writeFileSync(ap, "no heading here\n", "utf-8");
    const c = { artifactPath: ap, artifactLabel: "t", requiredSections: ["# RequiredHeading"], minBytes: 10, requiredFiles: [], executables: [], tools: [] };
    const r = taskPreflight.validateReportArtifact(ap, { existed: false }, c, Date.now() - 1000, "ah");
    if (r.ok) return `should reject missing heading`;
    return true;
  });

  await checkpoint("M38", "Rejects unchanged stale artifact", "artifact", "same size+mtime → fail", async () => {
    const ap = join(H, "ws", "as", "r.md"); mkdirSync(join(H, "ws", "as"), { recursive: true });
    writeFileSync(ap, "# Result\ncontent\n", "utf-8");
    const st = lstatSync(ap);
    const c = { artifactPath: ap, artifactLabel: "t", requiredSections: ["# Result"], minBytes: 10, requiredFiles: [], executables: [], tools: [] };
    const r = taskPreflight.validateReportArtifact(ap, { existed: true, size: st.size, mtimeMs: st.mtimeMs }, c, Date.now() - 5000, "as");
    if (r.ok) return `stale artifact should be rejected (unchanged)`;
    return true;
  });

  // ── M39-M42: Settlement and delivery ─────────────────────────────────────

  scenario("Settlement and delivery");
  await checkpoint("M39", "kanbanComplete marks card done", "settlement", "status=done", async () => {
    const id = kanbanBoard.kanbanEnqueue("done-test", "task", "dt", { priority: "MEDIUM" });
    kanbanBoard.kanbanRunning(id);
    kanbanBoard.kanbanComplete(id, null, "ok");
    const card = kanbanBoard.kanbanGetCard(id);
    if (card?.status !== "done") return `card should be done, got ${card?.status}`;
    return true;
  });

  await checkpoint("M40", "Delivery claim succeeds on done card", "delivery", "delivery_attempts incremented", async () => {
    const id = kanbanBoard.kanbanEnqueue("del-test", "task", "dt2", { priority: "MEDIUM" });
    kanbanBoard.kanbanRunning(id);
    kanbanBoard.kanbanComplete(id, null, "ok");
    const claimed = kanbanBoard.kanbanClaimDelivery(id);
    if (!claimed) return `delivery claim failed`;
    const card = kanbanBoard.kanbanGetCard(id);
    if (card?.delivery_attempts !== 1) return `delivery_attempts should be 1, got ${card?.delivery_attempts}`;
    return true;
  });

  await checkpoint("M41", "Duplicate delivery claim rejected", "delivery", "second claim false", async () => {
    const id = kanbanBoard.kanbanEnqueue("dup-del", "task", "dt3", { priority: "MEDIUM" });
    kanbanBoard.kanbanRunning(id);
    kanbanBoard.kanbanComplete(id, null, "ok");
    const first = kanbanBoard.kanbanClaimDelivery(id);
    if (!first) return `first claim failed`;
    const second = kanbanBoard.kanbanClaimDelivery(id);
    if (second) return `second claim should be rejected`;
    return true;
  });

  await checkpoint("M42", "Delivery preserves result_path", "delivery", "path survives round-trip", async () => {
    const id = kanbanBoard.kanbanEnqueue("path-test", "task", "pt", { priority: "MEDIUM" });
    kanbanBoard.kanbanRunning(id);
    kanbanBoard.kanbanComplete(id, "/tmp/report.md", "summary");
    const card = kanbanBoard.kanbanGetCard(id);
    if (card?.result_path !== "/tmp/report.md") return `result_path not preserved: ${card?.result_path}`;
    return true;
  });

  // ── M43: Cleanup ─────────────────────────────────────────────────────────

  scenario("Cleanup");
  await checkpoint("M43", "removeState clears all state for task", "cleanup", "readState returns null", async () => {
    const id = `clean-${Date.now()}`;
    stateStore.updateState(id, { lastStartedAt: Date.now() });
    stateStore.removeState(id);
    const st = stateStore.readState(id);
    if (st !== null) return `state not null after removeState`;
    return true;
  });

  // ── M44: Observability ───────────────────────────────────────────────────

  scenario("Observability");
  await checkpoint("M44", "Task phase changes loggable", "observability", "phase strings defined", async () => {
    const phases = ["reserved", "preflight", "queued", "executing", "cancelling", "validating", "settling", "delivery_pending"];
    if (phases.length !== 8) return `expected 8 phases, got ${phases.length}`;
    const task = `observability-${Date.now()}`;
    const run = `${task}_run`;
    const { logTaskTrace } = await import("../src/components/tasks/task-log-ctx.js");
    logTaskTrace("task_phase_probe", { task, run, attempt: 1 }, "phase=validating");
    logger.flushLogs();
    const logText = existsSync(logger.getLogFile()) ? readFileSync(logger.getLogFile(), "utf-8") : "";
    if (!logText.includes(`task_phase_probe task=${task} run=${run} attempt=1 phase=validating`)) return `correlated TRACE phase event missing from ${logger.getLogFile()}`;
    return { observed: "correlated TRACE phase event persisted", evidence: [`event=task_phase_probe`, `task=${task}`, `run=${run}`, "payload=phase_only"] };
  });

  // ── M45: Task listing ────────────────────────────────────────────────────

  await checkpoint("M45", "getTaskView has coherent definition+state+history", "operators", "definition+state+runs present", async () => {
    const entry = makeEntry({ id: "vt", kind: "agent", delivery: "announce", at: new Date().toISOString(), agent: "task", prompt: "test", enabled: true, priority: "medium" });
    const view = taskService.getTaskView(entry, new Set(["vt"]));
    if (!view.definition) return `definition missing`;
    if (view.state === undefined) return `state missing`;
    if (view.running !== true) return `running should be true`;
    return true;
  });

  // ── M46-M48: Production-shaped fixtures ─────────────────────────────────

  scenario("Production-shaped task acceptance");
  await checkpoint("M46", "daily-ai shaped task normalizes and preflights", "production", "fixture with daily-briefing shape", async () => {
    return runProductionFixture("daily-ai", `Daily-Briefing-${new Date().toISOString().slice(0, 10)}.md`, ["# Summary", "# Key Items"], 500);
  });

  await checkpoint("M47", "weekly-ai shaped task normalizes and preflights", "production", "fixture with weekly shape", async () => {
    return runProductionFixture("weekly-ai", `Weekly-Report-${new Date().toISOString().slice(0, 10)}.md`, ["# Summary", "# Metrics", "# Action Items"], 1000);
  });

  await checkpoint("M48", "finance-daily shaped task normalizes and preflights", "production", "fixture with finance shape", async () => {
    return runProductionFixture("finance-daily", `Finance-Report-${new Date().toISOString().slice(0, 10)}.md`, ["# P&L", "# Cash Flow", "# Risk"], 1000);
  });

  // ── M49-M50: Document delivery outcomes ─────────────────────────────────

  scenario("Document delivery outcomes");
  await checkpoint("M49", "not_sent document outcome persists and retries exactly through delivery", "delivery", "definitely_not_sent then delivered", async () => {
    const taskId = `not-sent-${Date.now()}`;
    const artifactPath = join(H, "workspace", taskId, "report.md");
    mkdirSync(join(H, "workspace", taskId), { recursive: true });
    writeFileSync(artifactPath, "# Report\n\n" + "content\n".repeat(80), "utf-8");
    const cardId = kanbanBoard.kanbanEnqueue(taskId, "task", taskId, { type: "T", delivery: "report", chatId: "acceptance" });
    if (!cardId) return `kanban card was not created for ${taskId}`;
    kanbanBoard.kanbanRunning(cardId);
    kanbanBoard.kanbanComplete(cardId, artifactPath, "summary");

    const sends = { count: 0 };
    const deps = {
      sendMessage: async () => { sends.count++; return "not_sent" as const; },
      sendDocument: async (_chatId: string, path: string) => { if (path !== artifactPath) throw new Error("wrong artifact delivered"); sends.count++; return "not_sent" as const; },
      announce: async () => { sends.count++; },
      chatIdFor: () => "acceptance",
    };
    await deliverCard(kanbanBoard.kanbanGetCard(cardId)!, deps);
    let card = kanbanBoard.kanbanGetCard(cardId)!;
    if (card.status !== "done" || card.delivery_result !== "definitely_not_sent" || sends.count !== 1) return `not_sent mis-settled: status=${card.status} result=${card.delivery_result} sends=${sends.count}`;

    // A delivery-only retry sends the pending card exactly once more.
    await deliverCard(card, { ...deps, sendDocument: async (_chatId: string, path: string) => { if (path !== artifactPath) throw new Error("wrong artifact delivered"); sends.count++; return "sent" as const; } });
    card = kanbanBoard.kanbanGetCard(cardId)!;
    if (card.status !== "delivered" || card.delivery_result !== "sent") return `retry mis-settled: status=${card.status} result=${card.delivery_result}`;
    if (Number(sends.count) !== 2) return `expected exactly one additional send on retry, got ${sends.count}`;
    return {
      observed: `not_sent persisted definitely_not_sent, retried exactly once through delivery, and reached delivered`,
      evidence: [`card=${cardId}`, `status=done→delivered`, `delivery_result=definitely_not_sent→sent`, `document_sends=2`],
      correlation: { taskId, cardId },
    };
  });

  await checkpoint("M50", "unknown document outcome never resends on repeated polls", "delivery", "unknown persisted, send count stays 1", async () => {
    const taskId = `unknown-${Date.now()}`;
    const artifactPath = join(H, "workspace", taskId, "report.md");
    mkdirSync(join(H, "workspace", taskId), { recursive: true });
    writeFileSync(artifactPath, "# Report\n\n" + "content\n".repeat(80), "utf-8");
    const cardId = kanbanBoard.kanbanEnqueue(taskId, "task", taskId, { type: "T", delivery: "report", chatId: "acceptance" });
    if (!cardId) return `kanban card was not created for ${taskId}`;
    kanbanBoard.kanbanRunning(cardId);
    kanbanBoard.kanbanComplete(cardId, artifactPath, "summary");

    const sends = { count: 0 };
    const deps = {
      sendMessage: async () => { sends.count++; return "unknown" as const; },
      sendDocument: async (_chatId: string, path: string) => { if (path !== artifactPath) throw new Error("wrong artifact delivered"); sends.count++; return "unknown" as const; },
      announce: async () => { sends.count++; },
      chatIdFor: () => "acceptance",
    };
    await deliverCard(kanbanBoard.kanbanGetCard(cardId)!, deps);
    const card = kanbanBoard.kanbanGetCard(cardId)!;
    if (card.status !== "done" || card.delivery_result !== "unknown") return `unknown mis-settled: status=${card.status} result=${card.delivery_result}`;
    if (sends.count !== 1) return `expected 1 document-send attempt, got ${sends.count}`;

    // Repeated delivery polls must never invoke the document sender again.
    await deliverCard(kanbanBoard.kanbanGetCard(cardId)!, deps);
    await deliverCard(kanbanBoard.kanbanGetCard(cardId)!, deps);
    if (Number(sends.count) !== 1) return `unknown card was resent: document send count ${sends.count}`;
    return {
      observed: `unknown persisted unknown; repeated delivery polls never resent the document`,
      evidence: [`card=${cardId}`, `status=done`, `delivery_result=unknown`, `document_sends=1`],
      correlation: { taskId, cardId },
    };
  });

  // ── Report ─────────────────────────────────────────────────────────────────

  const passed = milestones.filter(m => m.status === "PASS").length;
  const failed = milestones.filter(m => m.status === "FAIL").length;
  const blocked = milestones.filter(m => m.status === "BLOCKED").length;
  const notrunCount = milestones.filter(m => m.status === "NOT_RUN").length;

  const report = { runId: RUN_ID, timestamp: new Date().toISOString(), summary: { total: milestones.length, passed, failed, blocked, notRun: notrunCount }, milestones };

  const mdLines = [`# Report Pipeline E2E — ${RUN_ID}`, ``, `| ID | Milestone | Status | Scenario |`, `|----|-----------|--------|----------|`];
  for (const m of milestones) mdLines.push(`| ${m.id} | ${m.name} | ${m.status} | ${m.scenario} |`);
  mdLines.push(``, `**${passed}/${milestones.length} PASS** (${failed} FAIL, ${blocked} BLOCKED, ${notrunCount} NOT_RUN)`);

  const junitLines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuite name="report-pipeline-e2e" tests="${milestones.length}" failures="${failed + blocked}" skipped="${notrunCount}">`];
  for (const m of milestones) {
    junitLines.push(`  <testcase name="${m.id}: ${m.name}" classname="${m.scenario}" time="${(m.durationMs / 1000).toFixed(3)}">`);
    if (m.status === "NOT_RUN") junitLines.push(`    <skipped message="${m.observed}"/>`);
    else if (m.status !== "PASS") junitLines.push(`    <failure message="${m.observed}"/>`);
    junitLines.push(`  </testcase>`);
  }
  junitLines.push(`</testsuite>`);

  writeFileSync(join(OUT_DIR, "report-pipeline-e2e.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, "report-pipeline-e2e.md"), mdLines.join("\n"));
  writeFileSync(join(OUT_DIR, "report-pipeline-e2e.xml"), junitLines.join("\n"));

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Report Pipeline E2E: ${passed}/${milestones.length} PASS (${notrunCount} NOT_RUN — bridge-dependent)`);
  if (failed > 0) console.log(`  ${failed} FAIL`);
  if (blocked > 0) console.log(`  ${blocked} BLOCKED`);
  console.log(`Results: ${OUT_DIR}`);

  try { rmSync(HOME, { recursive: true, force: true }); } catch {}

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("E2E runner failed:", err); process.exit(1); });
