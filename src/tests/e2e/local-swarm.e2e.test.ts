import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const origHome = process.env["ABTARS_HOME"];
let tempRoot = "";

const workerResponses = [
  `<summary>Worker A completed: analysis of criterion 1.</summary><claim criterion_id="c1">Analysis shows the system meets criterion 1 requirements.</claim>`,
  `<summary>Worker B completed: verification of criterion 2.</summary><claim criterion_id="c2">Verification confirms criterion 2 is satisfied.</claim>`,
  `<summary>Worker C completed: validation of criterion 3.</summary><claim criterion_id="c3">Validation demonstrates criterion 3 compliance.</claim>`,
];

describe("Local Swarm E2E", () => {
  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "abtars-e2e-"));
    process.env["ABTARS_HOME"] = join(tempRoot, "abtars-home");
    process.env["LOG_FORMAT"] = "json";
    const home = process.env["ABTARS_HOME"];
    mkdirSync(join(home, "kanban"), { recursive: true });
    mkdirSync(join(home, "logs"), { recursive: true });
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "users.json"), JSON.stringify({
      users: [{ userId: "test-master", role: "master", displayName: "Test Master" }],
    }));
  });

  afterAll(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    if (origHome) process.env["ABTARS_HOME"] = origHome;
  });

  it("three-Worker production journey completes with correct invariants", async () => {
    let nextResponseIndex = 0;

    const { spin } = await import("../../components/spin.js");
    const { requestReconcile, setWorkerAdapter } = await import("../../components/reconciler.js");
    const { kanbanEnqueue, kanbanGetCard, kanbanGetChildren } = await import("../../components/tasks/kanban-board.js");
    const { WorkerSupervisionStore } = await import("../../components/worker-supervision-store.js");
    const { ProjectReviewStore } = await import("../../components/project-acceptance/project-review-store.js");
    const { deliverCard } = await import("../../components/tasks/kanban-delivery.js");
    const { WorkerSupervisionService } = await import("../../components/worker-supervision-service.js");
    const { getOrcTools } = await import("../../components/transport/orc-tools.js");

    spin.setRuntime({
      lastUsage: null,
      session: async () => ({ sendPrompt: async () => "", destroy: async () => {}, isReady: true, transport: { sendPrompt: async () => "", isReady: true, destroy: () => {} } }) as any,
      complete: async () => {
        const resp = workerResponses[nextResponseIndex % workerResponses.length];
        nextResponseIndex++;
        return resp;
      },
      openExecution: async () => ({
        send: async () => {
          const resp = workerResponses[nextResponseIndex % workerResponses.length];
          nextResponseIndex++;
          return resp;
        },
        close: async () => {}, transport: {} as any, sessionKey: "mock", ephemeral: true, lastUsage: () => null,
      }),
      shutdown: async () => {},
    } as any);

    class MockWorkerAdapter {
      readonly kind = "agent";
      capacitySnapshot() { return { available: 3, max: 3 }; }
      async capacity() { return { available: 3, max: 3 }; }
      async start(claim: any) {
        const sup = new WorkerSupervisionService();
        const contract = sup.getContract(claim.contractId);
        if (!contract) return { kind: "start_failed" as const, reason: "contract not found", retryable: false };
        spin.dispatch({ type: "W", goal: contract.goal, source: "agent", cardId: claim.cardId, contract, attemptId: claim.attemptId, settlementOwner: "spin" });
        return { kind: "started" as const, attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
      }
      async cancel(claim: any) {
        const store = new WorkerSupervisionStore();
        store.requestCancel(claim.attemptId, "cancelled");
        store.cancelAttempt(claim.attemptId);
        return { kind: "cancelled" as const, attemptId: claim.attemptId };
      }
      async inspect() { return { kind: "running" as const, lifecycle: "running" as const }; }
    }
    setWorkerAdapter(new MockWorkerAdapter() as any);

    const projectCardId = kanbanEnqueue("E2E test project", "test", undefined, { type: "O", priority: "MEDIUM", deliveryMode: "deliver" });
    const card = kanbanGetCard(projectCardId);
    if (card) card.status = "running";

    const reviewStore = new ProjectReviewStore();
    reviewStore.ensureAwaitingContract(projectCardId);
    reviewStore.initializeSupervision(projectCardId, `root_${projectCardId}`, "awaiting_contract");

    const orcTools = getOrcTools();
    const defineContractTool = orcTools.find(t => t.name === "define_project_contract")!;

    const contractResult = await defineContractTool.execute({
      goal: "Complete the E2E test scenario with three workers",
      project_card_id: String(projectCardId),
      criteria: JSON.stringify([
        { id: "c1", description: "Criterion 1 is met" },
        { id: "c2", description: "Criterion 2 is satisfied" },
        { id: "c3", description: "Criterion 3 is compliant" },
      ]),
      required_outputs: JSON.stringify([{ id: "o1", description: "Summary report", kind: "report", required: true }]),
      constraints: JSON.stringify(["None"]),
    });

    expect(contractResult).not.toMatch(/^\[err\]/);

    const childCardIds: number[] = [];
    const childSvc = new WorkerSupervisionService();

    for (let i = 0; i < 3; i++) {
      const goal = `Worker ${String.fromCharCode(65 + i)}: verify criterion ${i + 1}`;
      const childId = kanbanEnqueue(goal, "agent", undefined, { type: "W", parent_id: projectCardId, priority: "MEDIUM" });
      childCardIds.push(childId);
      const result = childSvc.createChild(goal, childId, projectCardId, "test", {
        criteria: [{ id: `w_c${i + 1}`, description: `Verify criterion ${i + 1}` }],
        supportsRootCriteria: [`c${i + 1}`],
      });
      if ("error" in result) throw new Error(`createChild failed for worker ${i}: ${result.error}`);
    }

    expect(childCardIds).toHaveLength(3);

    for (const childId of childCardIds) requestReconcile(childId);

    const eventually = async <T>(readFn: () => T | null | undefined, label: string, timeoutMs = 15000): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = readFn();
        if (result != null) return result;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`eventually(${label}) timed out after ${timeoutMs}ms`);
    };

    await eventually(() => {
      const children = kanbanGetChildren(projectCardId);
      return children.filter(c => ["done", "delivered", "failed"].includes(c.status)).length >= 3 ? children : null;
    }, "children_terminal", 30000);

    const reviewCase_ = await eventually(() => {
      requestReconcile(projectCardId);
      return reviewStore.getLatestOpenCase(projectCardId) ?? null;
    }, "review_case", 10000);

    expect(reviewCase_).toBeTruthy();

    const supervision = reviewStore.getSupervision(projectCardId)!;
    reviewStore.settleAcceptance(projectCardId, reviewCase_!.id, { action: "accept", reason: "all criteria satisfied" }, "All criteria satisfied. Project accepted.");

    let sentCount = 0;
    const deps = {
      sendMessage: async () => { sentCount++; },
      sendDocument: async () => { sentCount++; },
      announce: async () => { sentCount++; },
      chatIdFor: () => "test_chat",
    };

    await deliverCard(kanbanGetCard(projectCardId)!, deps);
    expect(sentCount).toBe(1);

    for (const childId of childCardIds) requestReconcile(childId);
    requestReconcile(projectCardId);
    await new Promise(r => setTimeout(r, 500));

    await deliverCard(kanbanGetCard(projectCardId)!, deps);
    expect(sentCount).toBe(1);

    const finalCard = kanbanGetCard(projectCardId)!;
    const wss = new WorkerSupervisionStore();
    const supStore = new ProjectReviewStore();

    expect((wss.db.prepare("SELECT COUNT(*) as c FROM worker_contracts").get() as any)["c"]).toBe(3);
    expect((wss.db.prepare("SELECT COUNT(*) as c FROM worker_attempts").get() as any)["c"]).toBe(3);
    expect((wss.db.prepare("SELECT COUNT(*) as c FROM worker_results").get() as any)["c"]).toBe(3);
    expect((supStore.db.prepare("SELECT COUNT(*) as c FROM project_review_cases").get() as any)["c"]).toBe(1);
    expect((supStore.db.prepare("SELECT COUNT(*) as c FROM project_review_decisions").get() as any)["c"]).toBe(1);

    const finalSup = supStore.getSupervision(projectCardId);
    expect(finalSup?.state).toBe("accepted");
    expect(finalCard.status).toBe("delivered");
    expect(finalCard.delivery_result).toBe("sent");
  }, 120000);
});
