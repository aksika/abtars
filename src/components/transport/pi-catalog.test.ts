import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock lazyRequire so loadPiModels() never hits the real installer / network.
vi.mock("../../utils/lazy-require.js", () => ({ lazyRequire: vi.fn() }));

import {
  mapProviderName, resolveModelMeta, modelsForProvider,
  loadPiModels, getWarmedModels, isWarmed,
  _resetForTest, _setWarmedForTest,
  type PiModels,
} from "./pi-catalog.js";
import { lazyRequire } from "../../utils/lazy-require.js";

function fakeModel(over: Partial<{ id: string; contextWindow: number; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; reasoning: boolean }> = {}): NonNullable<ReturnType<PiModels["getModel"]>> {
  return {
    id: "glm-4.6", contextWindow: 128000, maxTokens: 8192,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, reasoning: true, input: ["text"],
    ...over,
  };
}

/** Build a fake warmed catalog implementing the PiModels surface. */
function fakeModels(opts: Partial<PiModels> = {}): PiModels {
  const list = opts.list ?? [fakeModel()];
  return {
    getModel: opts.getModel ?? ((_p: string, id: string) => list.find(m => m.id === id)),
    getModels: opts.getModels ?? ((_p?: string) => list),
    getProvider: opts.getProvider ?? ((_id: string) => ({ id: "zai" })),
    getAuth: opts.getAuth ?? (async () => ({ auth: { apiKey: "k" }, source: "env" })),
    refresh: opts.refresh ?? (async () => {}),
  };
}

describe("mapProviderName (C2)", () => {
  it("maps known pi providers by identity", () => {
    expect(mapProviderName("zai")).toBe("zai");
    expect(mapProviderName("openrouter")).toBe("openrouter");
    expect(mapProviderName("anthropic")).toBe("anthropic");
  });
  it("returns null for unmapped abtars providers (→ models.json floor)", () => {
    expect(mapProviderName("ollama")).toBeNull();
    expect(mapProviderName("kiro")).toBeNull();
    expect(mapProviderName("9router")).toBeNull();
  });
});

describe("resolveModelMeta (C1)", () => {
  it("returns null when no warmed catalog (cold cache → models.json)", () => {
    expect(resolveModelMeta("glm-4.6", "zai", null)).toBeNull();
  });
  it("returns null for an unmapped provider", () => {
    expect(resolveModelMeta("glm-4.6", "ollama", fakeModels())).toBeNull();
  });
  it("returns null when the model isn't in pi's catalog", () => {
    expect(resolveModelMeta("nope", "zai", fakeModels())).toBeNull();
  });
  it("returns pi metadata (source=pi) when resolvable", () => {
    const m = fakeModel({ contextWindow: 200000, maxTokens: 12000, cost: { input: 0.6, output: 2.2, cacheRead: 0.1, cacheWrite: 3 } });
    const out = resolveModelMeta("glm-4.6", "zai", fakeModels({ list: [m] }));
    expect(out).toEqual({ contextWindow: 200000, maxOutput: 12000, cost: { input: 0.6, output: 2.2 }, source: "pi" });
  });
});

describe("modelsForProvider (C5)", () => {
  it("annotates each model with auth status", async () => {
    _setWarmedForTest(fakeModels({
      list: [fakeModel({ id: "a" }), fakeModel({ id: "b" })],
      getAuth: async (m) => m.id === "a" ? { auth: { apiKey: "k" }, source: "env" } : undefined,
    }));
    const out = await modelsForProvider("zai");
    expect(out).not.toBeNull();
    expect(out?.find(x => x.id === "a")?.authStatus).toBe("usable");
    expect(out?.find(x => x.id === "b")?.authStatus).toBe("unconfigured");
  });
  it("marks getAuth-rejecting models as needs-login", async () => {
    _setWarmedForTest(fakeModels({
      list: [fakeModel({ id: "x" })],
      getAuth: async () => { throw new Error("oauth expired"); },
    }));
    expect((await modelsForProvider("zai"))?.[0]?.authStatus).toBe("needs-login");
  });
  it("returns null when the provider is unmapped", async () => {
    _setWarmedForTest(fakeModels());
    expect(await modelsForProvider("ollama")).toBeNull();
  });
});

describe("loadPiModels (C8)", () => {
  const mocked = vi.mocked(lazyRequire);

  beforeEach(() => {
    _resetForTest();
    mocked.mockReset();
  });

  it("returns null and does not throw when pi cannot be loaded (→ models.json floor)", async () => {
    mocked.mockRejectedValueOnce(new Error("ENOENT: cannot resolve @earendil-works/pi-ai"));
    await expect(loadPiModels()).resolves.toBeNull();
    expect(isWarmed()).toBe(true);   // attempted…
    expect(getWarmedModels()).toBeNull(); // …but unavailable
  });

  it("warms and caches the catalog on success", async () => {
    const fm = fakeModels({ list: [fakeModel({ id: "glm-4.6" })] });
    mocked.mockResolvedValueOnce({ builtinModels: () => fm } as never);
    const out = await loadPiModels();
    expect(out).toBe(fm);
    expect(getWarmedModels()).toBe(fm);
  });

  it("is idempotent — a second call does not re-load", async () => {
    const fm = fakeModels();
    mocked.mockResolvedValueOnce({ builtinModels: () => fm } as never);
    await loadPiModels();
    await loadPiModels(); // second call must not touch lazyRequire again
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});
