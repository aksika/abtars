import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateWorkerEvidence, resolveWorkspaceMember } from "./worker-evidence-verifier.js";
import type { WorkerAcceptanceContractV1 } from "./worker-contract.js";

let WS: string;

function makeContract(overrides: Partial<WorkerAcceptanceContractV1> = {}): WorkerAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: "c_verify_test",
    digest: "digest-verify",
    goal: "produce evidence",
    criteria: [
      { id: "c1", description: "artifact present" },
      { id: "c2", description: "check passes" },
    ],
    expected_artifacts: [
      { id: "a1", kind: "file", ref: "out/result.md", required: true, criterion_ids: ["c1"] },
    ],
    verification_commands: [
      { id: "v1", argv: ["test", "-s", "out/result.md"], timeout_ms: 5000, criterion_ids: ["c1"] },
      { id: "v2", argv: ["grep", "-q", "done", "out/result.md"], timeout_ms: 5000, criterion_ids: ["c2"] },
    ],
    required_capabilities: [],
    supports_root_criteria: ["r1"],
    limits: {},
    provenance: { root_card_id: 1, card_id: 2, authored_by: "orc", created_at: new Date().toISOString() },
    ...overrides,
  };
}

beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), "abtars-verify-"));
  mkdirSync(join(WS, "out"), { recursive: true });
});

afterEach(() => {
  rmSync(WS, { recursive: true, force: true });
});

describe("evaluateWorkerEvidence (#1656)", () => {
  it("passes criteria against a real temp workspace with relative refs", () => {
    writeFileSync(join(WS, "out", "result.md"), "all done\n");
    const evaluation = evaluateWorkerEvidence(makeContract(), WS);
    expect(evaluation.artifacts[0]).toMatchObject({ artifact_id: "a1", exists: true });
    expect(evaluation.criteria.map(c => [c.criterion_id, c.status])).toEqual([["c1", "passed"], ["c2", "passed"]]);
  });

  it("reports a safe missing artifact as not found and fails its criterion", () => {
    const evaluation = evaluateWorkerEvidence(makeContract(), WS);
    expect(evaluation.artifacts[0]).toMatchObject({ artifact_id: "a1", exists: false, error: "not found" });
    expect(evaluation.criteria.find(c => c.criterion_id === "c1")!.status).toBe("failed");
  });

  it("fails all checks and criteria when the workspace is missing — never process.cwd()", () => {
    const evaluation = evaluateWorkerEvidence(makeContract(), join(WS, "does-not-exist"));
    expect(evaluation.checks.every(c => c.exit_code === null && c.timed_out === false)).toBe(true);
    expect(evaluation.checks.every(c => c.stderr_excerpt.includes("workspace unavailable"))).toBe(true);
    expect(evaluation.artifacts.every(a => a.exists === false && a.error === "workspace unavailable")).toBe(true);
    expect(evaluation.criteria.every(c => c.status === "failed")).toBe(true);
  });

  it("fails all checks and criteria with no explicit workspace at all", () => {
    const evaluation = evaluateWorkerEvidence(makeContract(), undefined);
    expect(evaluation.checks.every(c => c.exit_code === null)).toBe(true);
    expect(evaluation.checks.every(c => c.stderr_excerpt.includes("workspace unavailable"))).toBe(true);
    expect(evaluation.criteria.every(c => c.status === "failed")).toBe(true);
  });

  it("resolves a nested command cwd inside the workspace", () => {
    mkdirSync(join(WS, "sub"), { recursive: true });
    writeFileSync(join(WS, "sub", "flag"), "x");
    const contract = makeContract({
      verification_commands: [
        { id: "v1", argv: ["test", "-f", "flag"], cwd: "sub", timeout_ms: 5000, criterion_ids: ["c1"] },
      ],
    });
    const evaluation = evaluateWorkerEvidence(contract, WS);
    expect(evaluation.checks[0]!.exit_code).toBe(0);
  });

  it("rejects a command cwd escaping the workspace", () => {
    const contract = makeContract({
      verification_commands: [
        { id: "v1", argv: ["true"], cwd: "../../../", timeout_ms: 5000, criterion_ids: ["c1"] },
      ],
    });
    const evaluation = evaluateWorkerEvidence(contract, WS);
    expect(evaluation.checks[0]!.exit_code).toBeNull();
    expect(evaluation.checks[0]!.stderr_excerpt).toContain("escapes workspace");
    expect(evaluation.criteria[0]!.status).toBe("failed");
  });

  it("rejects an artifact symlink escaping the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "abtars-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "secret");
      symlinkSync(join(outside, "secret.md"), join(WS, "out", "result.md"));
      const evaluation = evaluateWorkerEvidence(makeContract(), WS);
      expect(evaluation.artifacts[0]!.error).toBe("path escapes workspace");
      expect(evaluation.criteria[0]!.status).toBe("failed");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a missing target whose parent symlink escapes the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "abtars-outside-"));
    try {
      symlinkSync(outside, join(WS, "out", "link"));
      const contract = makeContract({
        expected_artifacts: [
          { id: "a1", kind: "file", ref: "out/link/nonexistent.md", required: true, criterion_ids: ["c1"] },
        ],
      });
      const evaluation = evaluateWorkerEvidence(contract, WS);
      expect(evaluation.artifacts[0]!.error).toBe("path escapes workspace");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveWorkspaceMember (#1656)", () => {
  it("resolves an existing relative member", () => {
    writeFileSync(join(WS, "out", "result.md"), "x");
    const result = resolveWorkspaceMember(WS, "out/result.md");
    expect(result.kind).toBe("ok");
  });

  it("returns not found for a safe missing member", () => {
    const result = resolveWorkspaceMember(WS, "out/nope.md");
    expect(result).toEqual({ kind: "missing", reason: "not found" });
  });

  it("rejects traversal lexically", () => {
    const result = resolveWorkspaceMember(WS, "../../etc/passwd");
    expect(result.kind).toBe("escape");
  });

  it("rejects an invalid workspace root", () => {
    expect(resolveWorkspaceMember(join(WS, "gone"), "x").kind).toBe("invalid_workspace");
    expect(resolveWorkspaceMember(undefined, "x").kind).toBe("invalid_workspace");
  });
});
