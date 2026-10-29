import { describe, expect, it, vi } from "vitest";
import { createBootCtx } from "./context.js";

vi.mock("../components/skill-watcher.js", () => ({
  SkillWatcher: class {
    async prepareAndGenerateCatalog(): Promise<void> {
      throw new Error("skill catalog preparation failed");
    }
  },
}));
vi.mock("../paths.js", () => ({ abtarsHome: () => "/tmp/abtars-phase-capabilities-test" }));

import { phaseCapabilities } from "./phase-capabilities.js";

describe("phaseCapabilities", () => {
  it("propagates skill catalog boot failure to the optional boot node", async () => {
    await expect(phaseCapabilities(createBootCtx())).rejects.toThrow("skill catalog preparation failed");
  });
});
