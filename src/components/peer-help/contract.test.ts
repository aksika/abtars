import { describe, it, expect } from "vitest";
import {
  parseHelpRequest, parseHelpResponse, parseHelpStatusRequest, parseHelpStatus,
  parseHelpWithdraw, parseContributionEvent, canonicalRequestHash,
  normalizeCapabilities, validateRequestId, generateContributionRef,
} from "./contract.js";

describe("parseHelpRequest", () => {
  const valid = {
    version: 1,
    request_id: "req_abc123",
    created_at: "2026-07-17T12:00:00Z",
    expires_at: "2026-07-17T12:05:00Z",
    goal: "do something",
    required_capabilities: ["docker", "gpu"],
  };

  it("accepts a valid request", () => {
    const r = parseHelpRequest(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.request_id).toBe("req_abc123");
      expect(r.value.required_capabilities).toEqual(["docker", "gpu"]);
    }
  });

  it("rejects null/undefined", () => {
    expect(parseHelpRequest(null).ok).toBe(false);
    expect(parseHelpRequest(undefined).ok).toBe(false);
  });

  it("rejects unsupported version", () => {
    expect(parseHelpRequest({ ...valid, version: 2 }).ok).toBe(false);
  });

  it("rejects missing request_id", () => {
    const { request_id: _, ...rest } = valid;
    expect(parseHelpRequest(rest).ok).toBe(false);
  });

  it("rejects over-length goal", () => {
    expect(parseHelpRequest({ ...valid, goal: "x".repeat(100_001) }).ok).toBe(false);
  });

  it("accepts 100k-char goal", () => {
    expect(parseHelpRequest({ ...valid, goal: "x".repeat(100_000) }).ok).toBe(true);
  });

  it("rejects over-length context", () => {
    expect(parseHelpRequest({ ...valid, context: "x".repeat(50_001) }).ok).toBe(false);
  });

  it("rejects invalid priority", () => {
    expect(parseHelpRequest({ ...valid, priority: "URGENT" }).ok).toBe(false);
  });

  it("normalizes required_capabilities", () => {
    const r = parseHelpRequest({ ...valid, required_capabilities: ["Docker", "docker", "GPU"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.required_capabilities).toEqual(["docker", "gpu"]);
  });

  it("rejects non-array required_capabilities", () => {
    expect(parseHelpRequest({ ...valid, required_capabilities: "docker" }).ok).toBe(false);
  });

  it("rejects missing goal", () => {
    expect(parseHelpRequest({ ...valid, goal: "" }).ok).toBe(false);
  });

  it("rejects expires_at <= created_at", () => {
    expect(parseHelpRequest({
      ...valid,
      created_at: "2026-07-17T12:05:00Z",
      expires_at: "2026-07-17T12:00:00Z",
    }).ok).toBe(false);
  });

  it("accepts expires_at == created_at (same instant)", () => {
    expect(parseHelpRequest({
      ...valid,
      expires_at: valid.created_at,
    }).ok).toBe(true);
  });

  it("rejects invalid target executor", () => {
    expect(parseHelpRequest({ ...valid, target: { executor: "k8s" } }).ok).toBe(false);
  });

  it("rejects pi target without workspace_alias", () => {
    expect(parseHelpRequest({ ...valid, target: { executor: "pi" } }).ok).toBe(false);
  });

  it("accepts pi target with workspace_alias", () => {
    const r = parseHelpRequest({ ...valid, target: { executor: "pi", workspace_alias: "devbox" } });
    expect(r.ok).toBe(true);
  });

  it("bounds capabilities to 50", () => {
    const caps = Array.from({ length: 60 }, (_, i) => `cap${i}`);
    const r = parseHelpRequest({ ...valid, required_capabilities: caps });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.required_capabilities).toHaveLength(50);
  });
});

describe("parseHelpResponse", () => {
  it("accepts accepted with contribution_ref", () => {
    const r = parseHelpResponse({ version: 1, request_id: "r1", decision: "accepted", contribution_ref: "help_abc" });
    expect(r.ok).toBe(true);
  });

  it("rejects accepted without contribution_ref", () => {
    expect(parseHelpResponse({ version: 1, request_id: "r1", decision: "accepted" }).ok).toBe(false);
  });

  it("accepts declined without contribution_ref", () => {
    expect(parseHelpResponse({ version: 1, request_id: "r1", decision: "declined" }).ok).toBe(true);
  });

  it("rejects invalid decision", () => {
    expect(parseHelpResponse({ version: 1, request_id: "r1", decision: "maybe" }).ok).toBe(false);
  });
});

describe("parseHelpStatusRequest", () => {
  it("accepts valid", () => {
    const r = parseHelpStatusRequest({ version: 1, request_id: "r1", contribution_ref: "help_abc" });
    expect(r.ok).toBe(true);
  });

  it("rejects missing contribution_ref", () => {
    expect(parseHelpStatusRequest({ version: 1, request_id: "r1" }).ok).toBe(false);
  });
});

describe("parseHelpStatus", () => {
  it("accepts valid running state", () => {
    const r = parseHelpStatus({
      version: 1, request_id: "r1", contribution_ref: "help_abc",
      state: "running", updated_at: "2026-07-17T12:00:00Z",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects invalid state", () => {
    expect(parseHelpStatus({
      version: 1, request_id: "r1", contribution_ref: "help_abc",
      state: "boom", updated_at: "2026-07-17T12:00:00Z",
    }).ok).toBe(false);
  });
});

describe("parseHelpWithdraw", () => {
  it("accepts valid", () => {
    const r = parseHelpWithdraw({ version: 1, request_id: "r1", contribution_ref: "help_abc" });
    expect(r.ok).toBe(true);
  });
});

describe("parseContributionEvent", () => {
  it("accepts valid progress event", () => {
    const r = parseContributionEvent({
      version: 1, event_id: "evt1", sequence: 0, request_id: "r1",
      contribution_ref: "help_abc", kind: "progress", occurred_at: "2026-07-17T12:00:00Z",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects negative sequence", () => {
    expect(parseContributionEvent({
      version: 1, event_id: "evt1", sequence: -1, request_id: "r1",
      contribution_ref: "help_abc", kind: "progress", occurred_at: "2026-07-17T12:00:00Z",
    }).ok).toBe(false);
  });

  it("rejects invalid kind", () => {
    expect(parseContributionEvent({
      version: 1, event_id: "evt1", sequence: 0, request_id: "r1",
      contribution_ref: "help_abc", kind: "bogus", occurred_at: "2026-07-17T12:00:00Z",
    }).ok).toBe(false);
  });
});

describe("normalizeCapabilities", () => {
  it("deduplicates, lowercases, sorts", () => {
    expect(normalizeCapabilities(["GPU", "docker", "Docker", "gpu"]))
      .toEqual(["docker", "gpu"]);
  });

  it("returns empty for non-array", () => {
    expect(normalizeCapabilities("docker")).toEqual([]);
  });

  it("skips over-length capabilities", () => {
    expect(normalizeCapabilities(["ok", "x".repeat(129)])).toEqual(["ok"]);
  });
});

describe("validateRequestId", () => {
  it("accepts alphanumeric, dot, colon, dash, underscore", () => {
    expect(validateRequestId("req_1.2:3-4")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateRequestId("")).toBe(false);
  });

  it("rejects special chars like spaces", () => {
    expect(validateRequestId("req 1")).toBe(false);
  });

  it("rejects over 128 chars", () => {
    expect(validateRequestId("x".repeat(129))).toBe(false);
  });
});

describe("canonicalRequestHash", () => {
  it("returns a deterministic 64-char hex string", () => {
    const h1 = canonicalRequestHash({
      version: 1, request_id: "r1", created_at: "", expires_at: "",
      goal: "do x", required_capabilities: ["a", "b"],
    });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stable across key order (same goal, caps)", () => {
    const h1 = canonicalRequestHash({
      version: 1, request_id: "r1", created_at: "", expires_at: "",
      goal: "do x", required_capabilities: ["a", "b"],
    });
    const h2 = canonicalRequestHash({
      version: 1, request_id: "r1", created_at: "", expires_at: "",
      goal: "do x", required_capabilities: ["b", "a"],
    });
    expect(h1).toBe(h2);
  });

  it("differs on goal change", () => {
    const h1 = canonicalRequestHash({
      version: 1, request_id: "r1", created_at: "", expires_at: "",
      goal: "do x", required_capabilities: ["a"],
    });
    const h2 = canonicalRequestHash({
      version: 1, request_id: "r1", created_at: "", expires_at: "",
      goal: "do y", required_capabilities: ["a"],
    });
    expect(h1).not.toBe(h2);
  });
});

describe("generateContributionRef", () => {
  it("returns a string starting with help_", () => {
    expect(generateContributionRef()).toMatch(/^help_[0-9a-f]{16}$/);
  });
});
