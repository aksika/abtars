import { describe, expect, it } from "vitest";
import { PiSoulGate } from "./pi-soul-gate.js";
import { composeSoulTransform, invalidateSoulOnLifecycle } from "./pi-soul-composer.js";

const ADMIT = { abmindAvailable: true, archiveAcknowledged: true };

function hydratedGate(generation = 1): PiSoulGate {
  const gate = new PiSoulGate();
  if (!gate.completeHydration({ bundle: 1 }, generation, generation)) {
    throw new Error("hydration failed in test setup");
  }
  return gate;
}

describe("pi-soul-composer", () => {
  it("preserves the previous projection and appends exactly one marked bundle", async () => {
    const gate = hydratedGate();
    const previous = async (messages: readonly Record<string, unknown>[]) => [...messages, { projected: true }];
    const transform = composeSoulTransform(gate, previous, 1, ADMIT, () => ({ marker: "soul/v1", text: "bundle" }));

    const result = await transform([{ role: "user" }]);
    expect(result).toEqual([{ role: "user" }, { projected: true }, { marker: "soul/v1", text: "bundle" }]);
    const bundles = result.filter((message) => (message as { marker?: string }).marker === "soul/v1");
    expect(bundles).toHaveLength(1);
  });

  it("denies the request before the provider when hydration is pending", async () => {
    const gate = new PiSoulGate();
    const transform = composeSoulTransform(gate, undefined, 1, ADMIT, () => ({ marker: "soul/v1", text: "b" }));
    await expect(transform([])).rejects.toThrow(/hydration-pending/);
  });

  it("denies when the bundle is gone or admission fails", async () => {
    const gate = hydratedGate();
    const noBundle = composeSoulTransform(gate, undefined, 1, ADMIT, () => undefined);
    await expect(noBundle([])).rejects.toThrow(/bundle unavailable/);

    const noAbmind = composeSoulTransform(gate, undefined, 1, { abmindAvailable: false, archiveAcknowledged: true }, () => ({
      marker: "soul/v1",
      text: "b",
    }));
    await expect(noAbmind([])).rejects.toThrow(/abmind-unavailable/);
  });

  it("invalidates on lifecycle boundaries so the next request rehydrates", async () => {
    const gate = hydratedGate();
    const transform = composeSoulTransform(gate, undefined, 1, ADMIT, () => ({ marker: "soul/v1", text: "b" }));
    invalidateSoulOnLifecycle(gate);
    await expect(transform([])).rejects.toThrow(/hydration-pending/);
  });

  it("rejects a superseded generation even with a valid bundle", async () => {
    const gate = hydratedGate(1);
    const transform = composeSoulTransform(gate, undefined, 2, ADMIT, () => ({ marker: "soul/v1", text: "b" }));
    await expect(transform([])).rejects.toThrow(/generation-changed/);
  });
});
