/**
 * #1320 — Telegram model picker: tiered ranking (pi-catalog small → direct; large/empty →
 * curated models.json validated against live catalog), and graceful empty-curated message.
 * #1875 — pi-managed menu sources the runtime composition; apply accepts any offered model.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const MOCK_getModelsForProvider = vi.fn();
const MOCK_modelsForProviderSync = vi.fn();
const MOCK_writeTransportConfig = vi.fn();
const MOCK_piRuntimeModelsForProvider = vi.fn();
const MOCK_isPiManagedModelKnown = vi.fn();
const MOCK_checkPiManagedAuth = vi.fn();

vi.mock("../../components/transport-config.js", () => ({
  getModelsForProvider: MOCK_getModelsForProvider,
  formatRank: (r: number) => "★".repeat(Math.max(1, Math.min(5, 6 - r))) + "☆".repeat(Math.max(0, 5 - Math.max(1, Math.min(5, 6 - r)))),
  formatCost: (c: { input: number; output: number }) => {
    if (c.input === 0 && c.output === 0) return "free";
    return `$${c.input}/$${c.output}`;
  },
  loadTransport: () => ({
    activeRoute: "pi-ai",
    routes: {
      "pi-ai": {
        agents: {
          main: { model: "tencent/hy3-preview", provider: "openrouter" },
          professor: { model: "tencent/hy3-preview", provider: "openrouter" },
        },
        fallbacks: [],
      },
    },
    agents: {
      professor: { model: "tencent/hy3-preview", provider: "openrouter", fallbacks: [] },
    },
    providers: {
      openrouter: { transport: "api", endpoint: "https://openrouter.ai/api/v1" },
      codex: { transport: "api" },
      "opencode-go": { transport: "api", authSource: "pi" },
    },
  }),
  resolveAgent: () => ({ model: "tencent/hy3-preview", providerName: "openrouter" }),
  getAvailableProviders: () => [
    { name: "openrouter", config: { transport: "api", endpoint: "https://openrouter.ai/api/v1" } },
    { name: "codex", config: { transport: "api" } },
    { name: "opencode-go", config: { transport: "api", authSource: "pi" } },
  ],
  writeTransportConfig: MOCK_writeTransportConfig,
  cleanDemotedModels: vi.fn(),
  validateProviderReady: () => ({ ok: true }),
  formatValidationError: () => "",
}));

vi.mock("../../components/transport/pi-catalog.js", () => ({
  modelsForProviderSync: MOCK_modelsForProviderSync,
  mapProviderName: (name: string) => (["openrouter", "codex", "opencode-go"].includes(name) ? name : null),
  logUnmappedProviderOnce: vi.fn(),
  // #1875: picker entry refreshes before building lists — no-op in these tests.
  refreshPiCatalog: vi.fn(async () => null),
}));

vi.mock("../../components/transport/pi-runtime.js", () => ({
  // #1875: picker entry refreshes before building lists — no-op in these tests.
  refreshPiRuntime: vi.fn(async () => true),
  piRuntimeModelsForProvider: MOCK_piRuntimeModelsForProvider,
  isPiManagedModelKnown: MOCK_isPiManagedModelKnown,
  checkPiManagedAuth: MOCK_checkPiManagedAuth,
}));

import { handleModelPickerCallback, isModelPickerCallback } from "./telegram-model-picker.js";
import type { PickerState, PickerDeps } from "./telegram-model-picker.js";

function makeState(): PickerState {
  return { _pendingSlot: undefined, _modelPickerCache: [] };
}
function makeDeps(): PickerDeps {
  return {
    transport: { setModel: vi.fn() },
    pipeline: { rebuildTransport: vi.fn() },
    resetSessionForModelSwitch: vi.fn(),
  };
}
function makeApi() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) };
}

const CATALOG_OR_LARGE = Array.from({ length: 256 }, (_, i) => ({
  id: `vendor/cat-model-${i}`,
  cost: { input: 1, output: 2 },
}));

describe("telegram-model-picker (#1320)", () => {
  beforeEach(() => {
    MOCK_getModelsForProvider.mockReset();
    MOCK_modelsForProviderSync.mockReset();
    MOCK_writeTransportConfig.mockReset();
    MOCK_piRuntimeModelsForProvider.mockReset();
    MOCK_isPiManagedModelKnown.mockReset();
    MOCK_checkPiManagedAuth.mockReset();
    // Defaults: runtime unavailable → static pi-ai catalog path (pre-#1875 behavior).
    MOCK_piRuntimeModelsForProvider.mockResolvedValue(null);
    MOCK_isPiManagedModelKnown.mockResolvedValue(false);
    MOCK_checkPiManagedAuth.mockResolvedValue({ ok: true, state: "usable", detail: "" });
  });

  describe("isModelPickerCallback", () => {
    it("recognizes all known prefixes", () => {
      expect(isModelPickerCallback("mb:")).toBe(true);
      expect(isModelPickerCallback("mslot:professor")).toBe(true);
      expect(isModelPickerCallback("mprov:agent:openrouter")).toBe(true);
      expect(isModelPickerCallback("mprov2:professor:openrouter")).toBe(true);
      expect(isModelPickerCallback("mset:openrouter:0")).toBe(true);
      expect(isModelPickerCallback("model:foo")).toBe(true);
    });
    it("rejects unrelated callbacks", () => {
      expect(isModelPickerCallback("auth:yes")).toBe(false);
      expect(isModelPickerCallback("foo")).toBe(false);
    });
  });

  describe("mprov:agent:provider — tiered entries (#1320)", () => {
    it("small pi-catalog (<=20) → use pi list directly", async () => {
      MOCK_modelsForProviderSync.mockReturnValue([
        { id: "alpha", cost: { input: 0, output: 0 } },
        { id: "beta", cost: { input: 1, output: 2 } },
      ]);
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mprov:professor:openrouter", 1, api as never, state, deps);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      const buttons = (opts as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup.inline_keyboard;
      // Telegram inline buttons always carry text (Bot API Button shape).
      const labels = (buttons.flat() as Array<{ text: string }>).map((b) => b.text);
      expect(labels).toContain("alpha (free)");
      expect(labels).toContain("beta ($1/$2)");
      expect(labels.some((l: string) => l.startsWith("← Back"))).toBe(true);
    });

    it("large pi-catalog (>50) → use curated models.json, filtered against pi-ai catalog", async () => {
      MOCK_modelsForProviderSync.mockReturnValue(CATALOG_OR_LARGE);
      MOCK_getModelsForProvider.mockReturnValue([
        { id: "vendor/cat-model-5", entry: { rank: 1, cost: { input: 1, output: 2 } } },
        { id: "vendor/cat-model-3", entry: { rank: 2, cost: { input: 0, output: 0 } } },
        // Stale id NOT in pi-ai catalog — must be filtered out to prevent 404s.
        { id: "stale-id-not-in-catalog", entry: { rank: 1, cost: { input: 0, output: 0 } } },
      ]);
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mprov:professor:openrouter", 1, api as never, state, deps);
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      const buttons = (opts as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup.inline_keyboard;
      // Telegram inline buttons always carry text (Bot API Button shape).
      const labels = (buttons.flat() as Array<{ text: string }>).map((b) => b.text);
      expect(labels).toContain("vendor/cat-model-5 (★★★★★, $1/$2)");
      expect(labels).toContain("vendor/cat-model-3 (★★★★☆, free)");
      // Stale id absent from pi-ai catalog is filtered out.
      expect(labels).not.toContain("stale-id-not-in-catalog (★★★★★, free)");
    });

    it("non-pi provider (pi catalog null) → curated list unvalidated", async () => {
      MOCK_modelsForProviderSync.mockReturnValue(null);
      MOCK_getModelsForProvider.mockReturnValue([
        { id: "custom-model", entry: { rank: 2, cost: { input: 1, output: 2 } } },
      ]);
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mprov:professor:codex", 1, api as never, state, deps);
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      const buttons = (opts as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup.inline_keyboard;
      // Telegram inline buttons always carry text (Bot API Button shape).
      const labels = (buttons.flat() as Array<{ text: string }>).map((b) => b.text);
      expect(labels).toContain("custom-model (★★★★☆, $1/$2)");
    });

    it("empty curated list (big un-curated provider) → graceful defer message, not empty keyboard", async () => {
      MOCK_modelsForProviderSync.mockReturnValue(CATALOG_OR_LARGE);
      MOCK_getModelsForProvider.mockReturnValue([]);
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mprov:professor:openrouter", 1, api as never, state, deps);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [, text, opts] = api.sendMessage.mock.calls[0]!;
      expect(text as string).toMatch(/No curated models for openrouter/);
      expect(text as string).toMatch(/\/models quick <id>/);
      // No inline_keyboard in the graceful path — it would be empty/broken.
      expect(opts).toBeUndefined();
    });

    it("hard cap: even if curated has 60 entries, picker shows <=50", async () => {
      MOCK_modelsForProviderSync.mockReturnValue(null);
      const many = Array.from({ length: 60 }, (_, i) => ({
        id: `curated-${i}`,
        entry: { rank: 1, cost: { input: 0, output: 0 } },
      }));
      MOCK_getModelsForProvider.mockReturnValue(many);
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mprov:professor:openrouter", 1, api as never, state, deps);
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      const buttons = (opts as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup.inline_keyboard;
      // 50 model buttons + 1 back button = 51 rows.
      expect(buttons.length).toBe(51);
    });
  });

  describe("mprov2:slot:provider — empty-curated graceful message", () => {
    it("big un-curated provider → graceful defer message (no empty keyboard)", async () => {
      MOCK_modelsForProviderSync.mockReturnValue(CATALOG_OR_LARGE);
      MOCK_getModelsForProvider.mockReturnValue([]);
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mprov2:professor:openrouter", 1, api as never, state, deps);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [, text, opts] = api.sendMessage.mock.calls[0]!;
      expect(text as string).toMatch(/No curated models for openrouter/);
      expect(opts).toBeUndefined();
    });
  });

  describe("#1875 — menu and apply agree on the refreshed model set", () => {
    it("pi-managed provider → menu comes from the runtime composition, not the static catalog", async () => {
      MOCK_modelsForProviderSync.mockReturnValue([{ id: "static-only", cost: { input: 1, output: 1 } }]);
      MOCK_piRuntimeModelsForProvider.mockResolvedValue([
        { id: "deepseek-v4.1-flash", cost: { input: 0.14, output: 0.28 }, contextWindow: 200000 },
      ]);
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mprov:professor:opencode-go", 1, api as never, state, deps);
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      const buttons = (opts as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup.inline_keyboard;
      const labels = (buttons.flat() as Array<{ text: string }>).map((b) => b.text);
      expect(labels).toContain("deepseek-v4.1-flash ($0.14/$0.28)");
      expect(labels).not.toContain("static-only ($1/$1)");
    });

    it("applies a pi-catalog model that curated models.json does not list", async () => {
      MOCK_modelsForProviderSync.mockReturnValue([{ id: "omen-alpha", cost: { input: 0.1, output: 0.2 } }]);
      MOCK_getModelsForProvider.mockReturnValue([]);
      MOCK_writeTransportConfig.mockReturnValue({ ok: true });
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mprov:professor:openrouter", 1, api as never, state, deps);
      await handleModelPickerCallback("mset:openrouter:0", 1, api as never, state, deps);
      const texts = api.sendMessage.mock.calls.map(c => String(c[1]));
      expect(MOCK_writeTransportConfig).toHaveBeenCalledTimes(1);
      expect(texts.some(t => t.includes("omen-alpha"))).toBe(true);
      expect(texts.some(t => t.includes("not available"))).toBe(false);
    });

    it("applies a runtime-known model on a pi-managed provider", async () => {
      MOCK_modelsForProviderSync.mockReturnValue(null);
      MOCK_getModelsForProvider.mockReturnValue([]);
      MOCK_isPiManagedModelKnown.mockResolvedValue(true);
      MOCK_writeTransportConfig.mockReturnValue({ ok: true });
      const api = makeApi();
      const state = makeState();
      state._pendingSlot = "professor";
      const deps = makeDeps();
      await handleModelPickerCallback("mset:opencode-go:muse-spark-1.3-contributor", 1, api as never, state, deps);
      expect(MOCK_isPiManagedModelKnown).toHaveBeenCalledWith("opencode-go", "muse-spark-1.3-contributor");
      expect(MOCK_writeTransportConfig).toHaveBeenCalledTimes(1);
      const texts = api.sendMessage.mock.calls.map(c => String(c[1]));
      expect(texts.some(t => t.includes("not available"))).toBe(false);
    });

    it("still rejects a model no source knows", async () => {
      MOCK_modelsForProviderSync.mockReturnValue(null);
      MOCK_getModelsForProvider.mockReturnValue([]);
      MOCK_isPiManagedModelKnown.mockResolvedValue(false);
      const api = makeApi();
      const state = makeState();
      const deps = makeDeps();
      await handleModelPickerCallback("mset:opencode-go:intruder-model", 1, api as never, state, deps);
      const texts = api.sendMessage.mock.calls.map(c => String(c[1]));
      expect(texts.some(t => t.includes("not available"))).toBe(true);
      expect(MOCK_writeTransportConfig).not.toHaveBeenCalled();
    });
  });
});
