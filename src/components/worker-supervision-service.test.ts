import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let Service: typeof import("./worker-supervision-service.js").WorkerSupervisionService;
let Store: typeof import("./worker-supervision-store.js").WorkerSupervisionStore;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `sup-svc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const svcMod = await import("./worker-supervision-service.js");
  Service = svcMod.WorkerSupervisionService;
  const storeMod = await import("./worker-supervision-store.js");
  Store = storeMod.WorkerSupervisionStore;
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

describe("WorkerSupervisionService", () => {
  it("createChild creates contract and attempt for a card", () => {
    const svc = new Service();
    const result = svc.createChild("Build report", 101, 100, "orc", {
      criteria: [{ id: "c1", description: "Report must exist" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "output/report.md", required: true, criterion_ids: ["c1"] }],
      verificationCommands: [{ id: "v1", argv: ["test", "-f", "output/report.md"], timeout_ms: 10_000, criterion_ids: ["c1"] }],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.contract.id).toMatch(/^c_/);
      expect(result.contract.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.contract.criteria[0]!.id).toBe("c1");
      expect(result.attemptId).toMatch(/^a_/);
    }
  });

  it("createChild returns error for duplicate card", () => {
    const svc = new Service();
    svc.createChild("Build report", 101, 100, "orc");
    const result = svc.createChild("Another report", 101, 100, "orc");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("already has a contract");
    }
  });

  it("getContractForCard returns parsed contract", () => {
    const svc = new Service();
    svc.createChild("Build report", 101, 100, "orc", {
      criteria: [{ id: "c1", description: "Test" }],
    });
    const contract = svc.getContractForCard(101);
    expect(contract).toBeDefined();
    expect(contract!.goal).toBe("Build report");
  });

  it("getContractForCard returns undefined for unknown card", () => {
    const svc = new Service();
    expect(svc.getContractForCard(999)).toBeUndefined();
  });

  it("cardHasContract returns correct state", () => {
    const svc = new Service();
    expect(svc.cardHasContract(101)).toBe(false);
    svc.createChild("Build report", 101, 100, "orc");
    expect(svc.cardHasContract(101)).toBe(true);
  });

  it("rejects evidence-free supervised children (no criteria)", () => {
    const svc = new Service();
    const result = svc.createChild("Do something", 101, 100, "orc");
    expect("error" in result).toBe(false);
  });

  it("renderContractForPrompt produces XML-formatted contract", () => {
    const svc = new Service();
    const result = svc.createChild("Build report", 101, 100, "orc", {
      criteria: [{ id: "c1", description: "Report must exist" }],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      const rendered = svc.renderContractForPrompt(result.contract);
      expect(rendered).toContain("<worker-contract");
      expect(rendered).toContain("<goal>Build report</goal>");
      expect(rendered).toContain('<criterion id="c1">');
    }
  });
});
