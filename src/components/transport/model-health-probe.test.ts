import { describe, expect, it } from "vitest";
import { MODEL_HEALTH_PROBE_MAX_TOKENS, modelHealthProbeBody } from "./model-health-probe.js";

describe("model health probe", () => {
  it("requests the provider-compatible minimum output budget", () => {
    expect(MODEL_HEALTH_PROBE_MAX_TOKENS).toBe(16);
    expect(modelHealthProbeBody("meta/muse-spark-1.3-contributor")).toEqual({
      model: "meta/muse-spark-1.3-contributor",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
    });
  });
});
