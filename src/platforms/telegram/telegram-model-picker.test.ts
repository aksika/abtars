/**
 * #1320 — Telegram model picker: tiered ranking (pi-catalog small → direct; large/empty →
 * curated models.json validated against live catalog), and graceful empty-curated message.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const MOCK_getModelsForProvider = vi.fn();
const MOCK_modelsForProviderSync = vi.fn();

vi.mock("../../components/transport-config.js", () => ({
  getModelsForProvider: MOCK_getModelsForProvider,
  formatRank: (r: number) => "★".repeat(Math.max(1, Math.min(5, 6 - r))) + "☆".repeat(Math.max(0, 5 - Math.max(1, Math.min(5, 6 - r)))),
  formatCost: (c: { input: number; output: number }) => {
    if (c.input === 0 && c.output === 0) return "free";
    return `$${c.input}/$${c.output}`;
  },
  loadTransport: () => ({
    agents: {
      professor: { model: "tencent/hy3-preview", provider: "openrouter", fallbacks: [] },
    },
    providers: {
      openrouter: { transport: "api", useProviderLib: true, endpoint: "https://openrouter.ai/api/v1" },
      codex: { transport: "api", useProviderLib: false },
    },
  }),
  resolveAgent: () => ({ model: "tencent/hy3-preview", providerName: "openrouter" }),
  getAvailableProviders: () => [
    { name: "openrouter", config: { transport: "api", useProviderLib: true } },
    { name: "codex", config: { transport: "api", useProviderLib: false } },
  ],
  writeTransportConfig: vi.fn(),
  validateProviderReady: () => ({ ok: true }),
  formatValidationError: () => "",
}));

vi.mock("../../components/transport/pi-catalog.js", () => ({
  modelsForProviderSync: MOCK_modelsForProviderSync,
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
      const labels = buttons.flat().map((b: { text: string }) => b.text);
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
      const labels = buttons.flat().map((b: { text: string }) => b.text);
      expect(labels).toContain("vendor/cat-model-5 (★★★★★, $1/$2)");
      expect(labels).toContain("vendor/cat-model-3 (★★★★☆, free)");
      // Stale id absent from pi-ai catalog is filtered out.
      expect(labels).not.toContain("stale-id-not-in-catalog (★★★★★, free)");
    });

    it("non-pi provider (useProviderLib:false) → curated list unvalidated", async () => {
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
      const labels = buttons.flat().map((b: { text: string }) => b.text);
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
});
