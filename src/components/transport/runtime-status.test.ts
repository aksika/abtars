import { describe, it, expect } from "vitest";
import { resolveRuntimeStatus, formatRuntimeRoute } from "./runtime-status.js";
import type { RuntimeStatusSnapshot } from "./kiro-transport.js";

describe("resolveRuntimeStatus", () => {
  it("live snapshot wins over configured fallback", () => {
    const transport = { getRuntimeStatus: () => ({ route: "direct-api" as const, provider: "live-prov", model: "live-model" }) };
    const status = resolveRuntimeStatus(transport, { route: "acp", provider: "cfg-prov", model: "cfg-model" });
    expect(status.route).toBe("direct-api");
    expect(status.provider).toBe("live-prov");
    expect(status.model).toBe("live-model");
  });

  it("config fills missing live fields", () => {
    const transport = { getRuntimeStatus: () => ({ route: "acp" as const }) };
    const status = resolveRuntimeStatus(transport, { provider: "cfg-prov", model: "cfg-model" });
    expect(status.route).toBe("acp");
    expect(status.provider).toBe("cfg-prov");
    expect(status.model).toBe("cfg-model");
  });

  it("returns empty when both live and config absent", () => {
    const status = resolveRuntimeStatus(null, {});
    expect(status.route).toBeUndefined();
    expect(status.provider).toBeUndefined();
    expect(status.model).toBeUndefined();
  });

  it("preserves zero contextPercent", () => {
    const transport = { getRuntimeStatus: () => ({ contextPercent: 0 }) };
    const status = resolveRuntimeStatus(transport, {});
    expect(status.contextPercent).toBe(0);
  });
});

describe("formatRuntimeRoute", () => {
  it("formats pi-ai API with provider", () => {
    expect(formatRuntimeRoute({ route: "pi-ai", provider: "openrouter" })).toBe("pi-ai API / openrouter");
  });

  it("formats Direct API with provider", () => {
    expect(formatRuntimeRoute({ route: "direct-api", provider: "ollama" })).toBe("Direct API / ollama");
  });

  it("formats ACP without provider", () => {
    expect(formatRuntimeRoute({ route: "acp" })).toBe("ACP");
  });

  it("shows unknown for API routes without provider", () => {
    expect(formatRuntimeRoute({ route: "direct-api" })).toBe("Direct API / unknown");
    expect(formatRuntimeRoute({ route: "pi-ai" })).toBe("pi-ai API / unknown");
  });

  it("returns Unknown route when no route set", () => {
    expect(formatRuntimeRoute({})).toBe("Unknown route");
  });
});
