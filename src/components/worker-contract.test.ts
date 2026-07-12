import { describe, it, expect } from "vitest";
import {
  validateContract,
  validateEnvelope,
  normalizeContract,
  computeDigest,
  computeEnvelopeDigest,
  redactEnvelope,
  createContractId,
  createAttemptId,
  findErrorsForPath,
  SUPPORTED_SCHEMA_VERSION,
  MAX_GOAL_LENGTH,
  MAX_CONTRACT_JSON_BYTES,
  MAX_ENVELOPE_JSON_BYTES,
  type WorkerAcceptanceContractV1,
  type WorkerResultEnvelopeV1,
  type ValidationIssue,
} from "./worker-contract.js";

const MINIMAL_CONTRACT: Record<string, unknown> = {
  schema_version: 1,
  id: "c_test_001",
  goal: "Build a report",
  criteria: [
    { id: "c1", description: "Report must exist" },
    { id: "c2", description: "Report must contain summary" },
  ],
  expected_artifacts: [
    { id: "a1", kind: "file", ref: "output/report.md", required: true, criterion_ids: ["c1"] },
  ],
  verification_commands: [
    { id: "v1", argv: ["test", "-f", "output/report.md"], timeout_ms: 10_000, criterion_ids: ["c1"] },
    { id: "v2", argv: ["grep", "-q", "Summary", "output/report.md"], timeout_ms: 10_000, criterion_ids: ["c2"] },
  ],
  required_capabilities: ["shell"],
  limits: { max_duration_ms: 120_000 },
  provenance: {
    root_card_id: 100,
    card_id: 101,
    authored_by: "orc",
    created_at: "2026-07-12T00:00:00.000Z",
  },
};

const MINIMAL_ENVELOPE: Record<string, unknown> = {
  schema_version: 1,
  attempt: {
    id: "a_test_001",
    ordinal: 1,
    contract_id: "c_test_001",
    contract_digest: "abc123",
    executor_kind: "local_worker",
    executor_id: "spin-01",
    started_at: "2026-07-12T00:00:00.000Z",
    finished_at: "2026-07-12T00:01:00.000Z",
  },
  outcome: "completed",
  criteria: [
    { criterion_id: "c1", status: "passed", evidence_ids: ["v1"] },
    { criterion_id: "c2", status: "passed", evidence_ids: ["v2"] },
  ],
  checks: [
    {
      check_id: "v1",
      argv: ["test", "-f", "output/report.md"],
      started_at: "2026-07-12T00:00:00.000Z",
      finished_at: "2026-07-12T00:00:01.000Z",
      timed_out: false,
      exit_code: 0,
      signal: null,
      stdout_excerpt: "",
      stderr_excerpt: "",
    },
  ],
  artifacts: [
    {
      artifact_id: "a1",
      exists: true,
      kind: "file",
      ref: "output/report.md",
      size: 1024,
      digest: "sha256-abc",
    },
  ],
  worker_report: {
    summary: "Report generated successfully",
    claims: [],
    unresolved_risks: [],
  },
};

describe("contract validation", () => {
  it("accepts a minimal valid contract", () => {
    const result = validateContract(MINIMAL_CONTRACT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.schema_version).toBe(1);
      expect(result.contract.goal).toBe("Build a report");
    }
  });

  it("rejects null input", () => {
    const result = validateContract(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects unknown schema_version", () => {
    const result = validateContract({ ...MINIMAL_CONTRACT, schema_version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "unknown_version")).toBe(true);
    }
  });

  it("rejects missing goal", () => {
    const { goal, ...noGoal } = MINIMAL_CONTRACT;
    const result = validateContract(noGoal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "missing_field" && e.path === "$.goal")).toBe(true);
    }
  });

  it("rejects empty criteria", () => {
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "too_few")).toBe(true);
    }
  });

  it("rejects duplicate criterion IDs", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      criteria: [
        { id: "c1", description: "first" },
        { id: "c1", description: "duplicate" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "duplicate_id")).toBe(true);
    }
  });

  it("rejects duplicate artifact IDs", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      expected_artifacts: [
        { id: "a1", kind: "file", ref: "output/a.txt", required: true, criterion_ids: [] },
        { id: "a1", kind: "file", ref: "output/b.txt", required: false, criterion_ids: [] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "duplicate_id")).toBe(true);
    }
  });

  it("rejects duplicate command IDs", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      verification_commands: [
        { id: "v1", argv: ["echo", "a"], timeout_ms: 5000, criterion_ids: [] },
        { id: "v1", argv: ["echo", "b"], timeout_ms: 5000, criterion_ids: [] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "duplicate_id")).toBe(true);
    }
  });

  it("rejects path traversal in artifact ref", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      expected_artifacts: [
        { id: "a1", kind: "file", ref: "../../etc/passwd", required: true, criterion_ids: [] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "traversal")).toBe(true);
    }
  });

  it("rejects absolute path in artifact ref", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      expected_artifacts: [
        { id: "a1", kind: "file", ref: "/etc/passwd", required: true, criterion_ids: [] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "traversal")).toBe(true);
    }
  });

  it("rejects shell metacharacters in argv", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      verification_commands: [
        { id: "v1", argv: ["sh", "-c", "echo hello; rm -rf /"], timeout_ms: 5000, criterion_ids: [] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "shell_string")).toBe(true);
    }
  });

  it("rejects oversized goal", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      goal: "x".repeat(MAX_GOAL_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "too_long" && e.path === "$.goal")).toBe(true);
    }
  });

  it("rejects oversized JSON", () => {
    const big = {
      ...MINIMAL_CONTRACT,
      goal: "x".repeat(4000),
      criteria: Array.from({ length: 20 }, (_, i) => ({
        id: `c${String(i).padStart(3, "0")}`,
        description: "x".repeat(500),
      })),
      expected_artifacts: Array.from({ length: 20 }, (_, i) => ({
        id: `a${String(i).padStart(3, "0")}`,
        kind: "file" as const,
        ref: "x".repeat(500),
        required: true,
        criterion_ids: Array.from({ length: 10 }, (__, j) => `c${String(j).padStart(3, "0")}`),
      })),
      verification_commands: Array.from({ length: 20 }, (_, i) => ({
        id: `v${String(i).padStart(3, "0")}`,
        argv: Array.from({ length: 50 }, (__, j) => `arg${j}_${"x".repeat(50)}`),
        timeout_ms: 10_000,
        criterion_ids: Array.from({ length: 10 }, (__, j) => `c${String(j).padStart(3, "0")}`),
      })),
      required_capabilities: Array.from({ length: 20 }, (_, i) => `cap_${String(i).padStart(2, "0")}_` + "x".repeat(80)),
    };
    const result = validateContract(big);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "too_long" && e.path === "$")).toBe(true);
    }
  });

  it("rejects missing provenance", () => {
    const { provenance, ...noProv } = MINIMAL_CONTRACT;
    const result = validateContract(noProv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "missing_field" && e.path === "$.provenance")).toBe(true);
    }
  });

  it("rejects invalid artifact kind", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      expected_artifacts: [
        { id: "a1", kind: "symlink", ref: "output/x", required: true, criterion_ids: [] },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects too many criteria", () => {
    const result = validateContract({
      ...MINIMAL_CONTRACT,
      criteria: Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, description: `criterion ${i}` })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "too_many" && e.path === "$.criteria")).toBe(true);
    }
  });
});

describe("digest computation", () => {
  it("produces deterministic digest for same input", () => {
    const d1 = computeDigest(MINIMAL_CONTRACT);
    const d2 = computeDigest(MINIMAL_CONTRACT);
    expect(d1).toBe(d2);
    expect(d1.length).toBe(64);
  });

  it("digest changes when goal changes", () => {
    const d1 = computeDigest(MINIMAL_CONTRACT);
    const d2 = computeDigest({ ...MINIMAL_CONTRACT, goal: "Different goal" });
    expect(d1).not.toBe(d2);
  });

  it("digest does not depend on digest field", () => {
    const withDigest = { ...MINIMAL_CONTRACT, digest: "abc123" };
    const withoutDigest = { ...MINIMAL_CONTRACT };
    expect(computeDigest(withDigest)).toBe(computeDigest(withoutDigest));
  });

  it("digest is stable across key reordering", () => {
    const shuffled: Record<string, unknown> = {};
    const keys = Object.keys(MINIMAL_CONTRACT).reverse();
    for (const k of keys) shuffled[k] = MINIMAL_CONTRACT[k];
    const d1 = computeDigest(MINIMAL_CONTRACT);
    const d2 = computeDigest(shuffled);
    expect(d1).toBe(d2);
  });
});

describe("normalizeContract", () => {
  it("normalizes a raw contract with generated ID and digest", () => {
    const { id, ...noId } = MINIMAL_CONTRACT;
    const result = normalizeContract(noId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.id).toMatch(/^c_/);
      expect(result.contract.digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("preserves existing ID and adds digest", () => {
    const result = normalizeContract(MINIMAL_CONTRACT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.id).toBe("c_test_001");
      expect(result.contract.digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects invalid contracts during normalization", () => {
    const result = normalizeContract({ schema_version: 1, goal: "" });
    expect(result.ok).toBe(false);
  });

  it("fills missing provenance with defaults", () => {
    const { provenance, ...noProv } = MINIMAL_CONTRACT;
    const result = normalizeContract(noProv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.provenance.authored_by).toBe("unknown");
    }
  });
});

describe("createContractId / createAttemptId", () => {
  it("generates unique contract IDs with prefix", () => {
    const id1 = createContractId();
    const id2 = createContractId();
    expect(id1).toMatch(/^c_/);
    expect(id1).not.toBe(id2);
  });

  it("generates unique attempt IDs with prefix", () => {
    const id1 = createAttemptId();
    const id2 = createAttemptId();
    expect(id1).toMatch(/^a_/);
    expect(id1).not.toBe(id2);
  });
});

describe("envelope validation", () => {
  it("accepts a minimal valid envelope", () => {
    const result = validateEnvelope(MINIMAL_ENVELOPE);
    expect(result.ok).toBe(true);
  });

  it("rejects null envelope", () => {
    const result = validateEnvelope(null);
    expect(result.ok).toBe(false);
  });

  it("rejects unknown schema_version", () => {
    const result = validateEnvelope({ ...MINIMAL_ENVELOPE, schema_version: 2 });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid outcome", () => {
    const result = validateEnvelope({ ...MINIMAL_ENVELOPE, outcome: "invalid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.tag === "type_error" && e.path === "$.outcome")).toBe(true);
    }
  });

  it("accepts all valid outcomes", () => {
    for (const outcome of ["completed", "failed", "cancelled", "timed_out"]) {
      const result = validateEnvelope({ ...MINIMAL_ENVELOPE, outcome });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects missing attempt field", () => {
    const { attempt, ...noAttempt } = MINIMAL_ENVELOPE;
    const result = validateEnvelope(noAttempt);
    expect(result.ok).toBe(false);
  });

  it("rejects oversized envelope JSON", () => {
    const big = {
      ...MINIMAL_ENVELOPE,
      worker_report: {
        summary: "x".repeat(6000),
        claims: Array.from({ length: 30 }, (_, i) => ({ text: "x".repeat(1000) })),
        unresolved_risks: ["x".repeat(1000)],
      },
      checks: Array.from({ length: 50 }, (_, i) => ({
        check_id: `c${i}`,
        argv: ["echo", "x".repeat(500)],
        started_at: "2026-07-12T00:00:00.000Z",
        finished_at: "2026-07-12T00:00:01.000Z",
        timed_out: false,
        exit_code: 0,
        signal: null,
        stdout_excerpt: "x".repeat(2000),
        stderr_excerpt: "",
      })),
    };
    const result = validateEnvelope(big);
    expect(result.ok).toBe(false);
  });
});

describe("envelope digest", () => {
  it("produces deterministic digest", () => {
    const d1 = computeEnvelopeDigest(MINIMAL_ENVELOPE);
    const d2 = computeEnvelopeDigest(MINIMAL_ENVELOPE);
    expect(d1).toBe(d2);
  });

  it("digest changes when outcome changes", () => {
    const d1 = computeEnvelopeDigest(MINIMAL_ENVELOPE);
    const d2 = computeEnvelopeDigest({ ...MINIMAL_ENVELOPE, outcome: "failed" });
    expect(d1).not.toBe(d2);
  });
});

describe("redactEnvelope", () => {
  it("truncates long excerpts", () => {
    const longCheck = {
      ...MINIMAL_ENVELOPE,
      checks: [
        {
          check_id: "v1",
          argv: ["test"],
          started_at: "",
          finished_at: "",
          timed_out: false,
          exit_code: 0,
          signal: null,
          stdout_excerpt: "x".repeat(1000),
          stderr_excerpt: "",
        },
      ],
    } as unknown as WorkerResultEnvelopeV1;
    const redacted = redactEnvelope(longCheck);
    expect(redacted.checks[0]!.stdout_excerpt.length).toBeLessThan(600);
  });
});

describe("findErrorsForPath", () => {
  it("filters errors by path prefix", () => {
    const errors: ValidationIssue[] = [
      { severity: "error", tag: "missing_field", path: "$.goal", message: "goal required" },
      { severity: "error", tag: "missing_field", path: "$.provenance.authored_by", message: "authored_by required" },
      { severity: "error", tag: "type_error", path: "$.criteria[0].id", message: "bad id" },
    ];
    const found = findErrorsForPath(errors, "$.provenance");
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("$.provenance.authored_by");
  });

  it("returns empty for non-matching path", () => {
    const errors: ValidationIssue[] = [
      { severity: "error", tag: "missing_field", path: "$.goal", message: "goal required" },
    ];
    expect(findErrorsForPath(errors, "$.nonexistent")).toHaveLength(0);
  });
});

describe("shared constants", () => {
  it("SUPPORTED_SCHEMA_VERSION is 1", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(1);
  });

  it("MAX_CONTRACT_JSON_BYTES is defined", () => {
    expect(MAX_CONTRACT_JSON_BYTES).toBeGreaterThan(0);
  });

  it("MAX_ENVELOPE_JSON_BYTES is defined", () => {
    expect(MAX_ENVELOPE_JSON_BYTES).toBeGreaterThan(0);
  });
});
