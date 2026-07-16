import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Model, Api, Models } from "@earendil-works/pi-ai";

// Mock pi-installation so loadPiModels() never hits the real filesystem.
vi.mock("../../components/pi-installation.js", () => ({ resolvePiInstallation: vi.fn(), createPiRequire: vi.fn() }));

import {
  mapProviderName, resolveModelMeta, modelsForProvider, modelsForProviderSync,
  piCostRatesByModel,
  loadPiModels, getWarmedModels, isWarmed,
  _resetForTest, _setWarmedForTest,
} from "./pi-catalog.js";
import { resolvePiInstallation, createPiRequire } from "../../components/pi-installation.js";

function fakeModel(over: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "glm-4.6", name: "glm-4.6", api: "openai-completions" as Api, provider: "zai",
    baseUrl: "https://api.z.ai/v1", reasoning: true,
    input: ["text"], contextWindow: 128000, maxTokens: 8192,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    ...over,
  };
}

/** Build a fake warmed catalog implementing the subset of the Models surface that
 * pi-catalog uses. The official Models interface has ~13 methods (stream/complete/
 * getProviders etc.) but the catalog only calls getModel/getModels/getProvider/
 * getAuth/refresh. The `as unknown as Models` cast skips implementing the
 * uncovered methods — they are never reached from the production code path. */
function fakeModels(opts: Partial<Models> = {}): Models {
  const list = opts.list ?? [fakeModel()];
  return {
    getModel: opts.getModel ?? ((_p: string, id: string) => list.find(m => m.id === id)),
    getModels: opts.getModels ?? ((_p?: string) => list),
    getProvider: opts.getProvider ?? ((_id: string) => ({ id: "zai", name: "zai", auth: { apiKey: { name: "ZAI_API_KEY", resolve: async () => ({ auth: { apiKey: "k" }, source: "env" }) } }, getModels: () => list, streamSimple: null as unknown as Models["streamSimple"] })),
    getAuth: opts.getAuth ?? (async () => ({ auth: { apiKey: "k" }, source: "env" })),
    refresh: opts.refresh ?? (async () => {}),
  } as unknown as Models;
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

describe("modelsForProviderSync (C5 picker)", () => {
  it("lists pi models with cost when warmed (no auth filtering)", () => {
    _setWarmedForTest(fakeModels({
      list: [fakeModel({ id: "glm-4.6", cost: { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 } }), fakeModel({ id: "glm-4.5" })],
    }));
    const out = modelsForProviderSync("zai");
    expect(out?.map(m => m.id)).toEqual(["glm-4.6", "glm-4.5"]);
    expect(out?.[0]?.cost).toEqual({ input: 0.6, output: 2.2 });
  });
  it("returns null for an unmapped provider or cold cache", () => {
    _setWarmedForTest(fakeModels());
    expect(modelsForProviderSync("ollama")).toBeNull();
    _resetForTest();
    expect(modelsForProviderSync("zai")).toBeNull();
  });
});

describe("piCostRatesByModel (C6)", () => {
  it("returns null on a cold cache", () => {
    _resetForTest();
    expect(piCostRatesByModel()).toBeNull();
  });
  it("maps model id → 4-component rates; first id wins on collision", () => {
    _setWarmedForTest(fakeModels({
      list: [
        fakeModel({ id: "glm-4.6", cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 1.1 } }),
        fakeModel({ id: "glm-4.6", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }),
        fakeModel({ id: "glm-4.5", cost: { input: 0.3, output: 1.1, cacheRead: 0.05, cacheWrite: 0.5 } }),
      ],
    }));
    const map = piCostRatesByModel();
    expect(map?.get("glm-4.6")).toEqual({ input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 1.1 });
    expect(map?.get("glm-4.5")).toEqual({ input: 0.3, output: 1.1, cacheRead: 0.05, cacheWrite: 0.5 });
  });
});

describe("loadPiModels (C8)", () => {
  const mockedResolve = vi.mocked(resolvePiInstallation);
  const mockedRequire = vi.mocked(createPiRequire);

  beforeEach(() => {
    _resetForTest();
    mockedResolve.mockReset();
    mockedRequire.mockReset();
  });

  it("returns null and does not throw when pi cannot be loaded (→ models.json floor)", async () => {
    mockedResolve.mockReturnValue({ state: "absent" });
    await expect(loadPiModels()).resolves.toBeNull();
    expect(isWarmed()).toBe(true);
    expect(getWarmedModels()).toBeNull();
  });

  it("returns null when pi is below-minimum", async () => {
    mockedResolve.mockReturnValue({
      state: "below-minimum",
      observedVersion: "0.80.5",
      reason: "below minimum",
      remediation: "update",
    });
    await expect(loadPiModels()).resolves.toBeNull();
    expect(isWarmed()).toBe(true);
    expect(getWarmedModels()).toBeNull();
  });

  it("warms and caches the catalog on success", async () => {
    const fm = fakeModels({ list: [fakeModel({ id: "glm-4.6" })] });
    const mockRequire = vi.fn().mockReturnValue({ builtinModels: () => fm });
    mockedResolve.mockReturnValue({
      state: "compatible",
      installation: {
        executable: "/usr/bin/pi",
        packageRoot: "/usr/lib/pi-coding-agent",
        version: "0.80.7",
        source: "path",
        moduleRoots: { ai: "/usr/lib/pi-ai", tui: "/usr/lib/pi-tui", agentCore: "/usr/lib/pi-agent-core" },
      },
    });
    mockedRequire.mockReturnValue(mockRequire as unknown as ReturnType<typeof createPiRequire>);
    const out = await loadPiModels();
    expect(out).toBe(fm);
    expect(getWarmedModels()).toBe(fm);
  });

  it("is idempotent — a second call does not re-load", async () => {
    const fm = fakeModels();
    const mockRequire = vi.fn().mockReturnValue({ builtinModels: () => fm });
    mockedResolve.mockReturnValue({
      state: "compatible",
      installation: {
        executable: "/usr/bin/pi",
        packageRoot: "/usr/lib/pi-coding-agent",
        version: "0.80.7",
        source: "path",
        moduleRoots: { ai: "/usr/lib/pi-ai", tui: "/usr/lib/pi-tui", agentCore: "/usr/lib/pi-agent-core" },
      },
    });
    mockedRequire.mockReturnValue(mockRequire as unknown as ReturnType<typeof createPiRequire>);
    await loadPiModels();
    await loadPiModels();
    expect(mockedResolve).toHaveBeenCalledTimes(1);
  });
});
