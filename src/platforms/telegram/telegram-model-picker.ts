/**
 * telegram-model-picker.ts — Extracted model picker callback handlers.
 * Handles: mb:, mslot:, mprov:, mpos:, mprov2:, mset:, model: prefixes.
 */
import type { TelegramApi } from "./telegram-api.js";
import type { CandidateSource } from "../../components/transport/model-candidates.js";
import { getEnv } from "../../components/env-schema.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";

const TAG = "telegram";

export interface PickerState {
  _pendingSlot: string | undefined;
  _modelPickerCache: string[];
}

export interface PickerDeps {
  transport: { setModel?: (m: string) => Promise<void> | void; switchProvider?: (o: unknown) => void; [k: string]: unknown };
  pipeline: { rebuildTransport?: () => Promise<void>; [k: string]: unknown };
  resetSessionForModelSwitch: (chatId: number, reason?: string) => Promise<void>;
}

const MODEL_PREFIXES = ["mb:", "mslot:", "mprov:", "mpos:", "mprov2:", "mset:", "model:"];

export function isModelPickerCallback(data: string): boolean {
  return MODEL_PREFIXES.some(p => data.startsWith(p));
}

/**
 * Build the normalized model list for a provider's picker page.
 *
 * Tiered (#1320):
 * - When the provider opts into pi-ai and the catalog is small (≤ PICKER_MAX), use the live
 *   pi-catalog directly (most accurate, includes models not yet in models.json).
 * - When the pi-catalog is large (> PICKER_MAX) or the provider doesn't opt in / catalog is
 *   cold, fall back to the curated `models.json` list. We DO NOT validate curated ids
 *   against the live pi-catalog: pi-ai passes through any model id we build into our
 *   `Model` object directly to the upstream provider, so a curated id missing from
 *   pi-ai's snapshot is still a valid call. model-scout's invariant ("Professor only puts
 *   working models into models.json") is the safety net. If a curated id is wrong, use
 *   `/model doctor` to find it.
 * - Always cap at PICKER_MAX as a hard backstop against the Telegram inline-keyboard size
 *   limit (~80 buttons, ~9KB markup JSON). Empty result is the caller's problem.
 */
const PICKER_MAX = 50;

async function buildModelEntries(providerName: string, providerConfig: { transport?: string; useProviderLib?: boolean } | undefined): Promise<Array<{ id: string; label: string }>> {
  const { getModelsForProvider, formatRank, formatCost } = await import("../../components/transport-config.js");

  // Tier 1: pi-catalog (small list → use directly)
  let pi: Array<{ id: string; cost: { input: number; output: number } }> | null = null;
  if (providerConfig?.useProviderLib) {
    const { modelsForProviderSync } = await import("../../components/transport/pi-catalog.js");
    pi = modelsForProviderSync(providerName);
  }
  if (pi && pi.length > 0 && pi.length <= PICKER_MAX) {
    return pi.map(m => ({ id: m.id, label: `${m.id} (${formatCost(m.cost)})` }));
  }

  // Tier 2: curated models.json, alive-filtered. No catalog validation — pi-ai passes
  // through whatever model id we hand it. (See function header.)
  const curated = getModelsForProvider(providerName);
  const filtered = providerConfig?.transport === "api" ? curated.filter(m => !m.entry.status || m.entry.status === "alive") : curated;
  return filtered.slice(0, PICKER_MAX).map(m => ({ id: m.id, label: `${m.id} (${formatRank(m.entry.rank)}, ${formatCost(m.entry.cost)})` }));
}

export async function handleModelPickerCallback(
  data: string, chatId: number, api: TelegramApi, state: PickerState, deps: PickerDeps,
): Promise<void> {

  if (data.startsWith("mb:")) {
    const target = data.slice(3);
    if (!target) { await api.sendMessage(chatId, "👌 Cancelled."); return; }
    if (target === "a") {
      const AGENT_LABELS = [
        { key: "main", label: "Main" },
        { key: "dreamy", label: "Dreamy (sleep)" },
        { key: "browsie", label: "Browsie (browse)" },
        { key: "cody", label: "Cody (coding)" },
      ];
      const buttons = AGENT_LABELS.map(a => [{ text: a.label, callback_data: `mslot:${a.key}` }]);
      buttons.push([{ text: "← Cancel", callback_data: "mb:" }]);
      await api.sendMessage(chatId, "🤖 Which agent to change?", { reply_markup: { inline_keyboard: buttons } });
      return;
    }
    if (target.startsWith("p:")) {
      const agent = target.slice(2);
      const { loadTransport, resolveAgent, getAvailableProviders, getModelsForProvider } = await import("../../components/transport-config.js");
      const tc = loadTransport();
      if (!tc) { await api.sendMessage(chatId, "❌ transport.json not loaded"); return; }
      let providers = getAvailableProviders(tc).filter(p => p.config.transport !== "tmux");
      if (providers.length === 0) { await api.sendMessage(chatId, "❌ No compatible providers"); return; }
      const currentProvider = resolveAgent(agent, tc)?.providerName;
      const prefix = agent === "main" ? "mprov2:main" : `mprov:${agent}`;
      const buttons = providers.map(p => {
        const count = getModelsForProvider(p.name).length;
        const label = p.name === currentProvider ? `✓ ${p.name} (${count})` : `${p.name} (${count})`;
        return [{ text: label, callback_data: `${prefix}:${p.name}` }];
      });
      buttons.push([{ text: "← Back", callback_data: "mb:a" }]);
      await api.sendMessage(chatId, `🔌 Pick provider:`, { reply_markup: { inline_keyboard: buttons } });
      return;
    }
    if (target.startsWith("s:")) {
      const slot = target.slice(2);
      state._pendingSlot = slot;
      const { loadTransport, resolveAgent, getAvailableProviders, getModelsForProvider } = await import("../../components/transport-config.js");
      const tc = loadTransport();
      if (!tc) { await api.sendMessage(chatId, "❌ transport.json not loaded"); return; }
      let providers = getAvailableProviders(tc).filter(p => p.config.transport !== "tmux");
      const currentProvider = resolveAgent("main", tc)?.providerName;
      const slotLabel = slot === "main" ? "Main" : "";
      const buttons = providers.map(p => {
        const count = getModelsForProvider(p.name).length;
        const label = p.name === currentProvider ? `✓ ${p.name} (${count})` : `${p.name} (${count})`;
        return [{ text: label, callback_data: `mprov2:${slot}:${p.name}` }];
      });
      buttons.push([{ text: "← Back", callback_data: "mslot:main" }]);
      await api.sendMessage(chatId, `🔌 Provider for ${slotLabel}:`, { reply_markup: { inline_keyboard: buttons } });
      return;
    }
  } else if (data.startsWith("mslot:")) {
    const agent = data.slice(6);
    const { loadTransport, resolveAgent, getAvailableProviders, getModelsForProvider } = await import("../../components/transport-config.js");
    const tc = loadTransport();
    if (!tc) { await api.sendMessage(chatId, "❌ transport.json not loaded"); return; }

    if (agent === "main") {
      const profResolved = resolveAgent("main", tc);
      const fallbacks = tc.fallbacks ?? [];
      const slots: Array<{ label: string; key: string }> = [
        { label: `★ Main: ${profResolved?.model ?? "?"}`, key: `mpos:main::main` },
      ];
      for (let i = 0; i < fallbacks.length; i++) {
        slots.push({ label: `↳ Fb${i + 1}: ${fallbacks[i]!.model}`, key: `mpos:main::fallback${i + 1}` });
      }
      if (fallbacks.length < 5) {
        slots.push({ label: `↳ Fb${fallbacks.length + 1}: (add)`, key: `mpos:main::fallback${fallbacks.length + 1}` });
      }
      const buttons = slots.map(s => [{ text: s.label, callback_data: s.key }]);
      buttons.push([{ text: "← Back", callback_data: "mb:a" }]);
      await api.sendMessage(chatId, `🎯 Which slot?`, { reply_markup: { inline_keyboard: buttons } });
      return;
    }

    let providers = getAvailableProviders(tc).filter(p => p.config.transport !== "tmux");
    if (providers.length === 0) { await api.sendMessage(chatId, "❌ No compatible providers"); return; }
    const currentProvider = resolveAgent(agent, tc)?.providerName;
    const buttons = providers.map(p => {
      const count = getModelsForProvider(p.name).length;
      const label = p.name === currentProvider ? `✓ ${p.name} (${count})` : `${p.name} (${count})`;
      return [{ text: label, callback_data: `mprov:${agent}:${p.name}` }];
    });
    buttons.push([{ text: "← Back", callback_data: "mb:a" }]);
    await api.sendMessage(chatId, `🔌 Pick provider:`, { reply_markup: { inline_keyboard: buttons } });

  } else if (data.startsWith("mprov:")) {
    const [, agent, providerName] = data.split(":");
    const { loadTransport } = await import("../../components/transport-config.js");
    const tc = loadTransport();
    const providerConfig = tc?.providers[providerName!];
    const entries = await buildModelEntries(providerName!, providerConfig);
    if (entries.length === 0) {
      // #1320: big un-curated pi-ai provider — defer to the modern TUI switcher + text escape.
      await api.sendMessage(chatId, `📋 No curated models for ${providerName} yet. Use the TUI to browse the full catalog, or \`/models quick <id>\`.`);
      return;
    }
    state._pendingSlot = agent;
    state._modelPickerCache = entries.map(e => e.id);
    const buttons = entries.map((e, i) => [{ text: e.label, callback_data: `mset:${providerName}:${i}` }]);
    buttons.push([{ text: "← Back", callback_data: `mb:p:${agent}` }]);
    await api.sendMessage(chatId, `📋 Models on ${providerName}:`, { reply_markup: { inline_keyboard: buttons } });

  } else if (data.startsWith("mpos:")) {
    const [, , , slot] = data.split(":");
    const { loadTransport, resolveAgent, getAvailableProviders, getModelsForProvider } = await import("../../components/transport-config.js");
    const tc = loadTransport();
    if (!tc) { await api.sendMessage(chatId, "❌ transport.json not loaded"); return; }
    let providers = getAvailableProviders(tc).filter(p => p.config.transport !== "tmux");
    const profResolved = resolveAgent("professor", tc);
    const mainTransport = profResolved?.provider.transport;
    if (slot && slot.startsWith("professor_fb") && mainTransport) {
      if (mainTransport === "api") { providers = providers.filter(p => p.config.transport === "api"); }
      else { providers = providers.filter(p => p.name === profResolved!.providerName); }
    }
    if (providers.length === 0) { await api.sendMessage(chatId, "❌ No compatible providers for this slot"); return; }
    const currentProvider = profResolved?.providerName;
    const slotLabel = slot === "professor" ? "Main" : slot!.replace("professor_fb", "Fb");
    const buttons = providers.map(p => {
      const count = getModelsForProvider(p.name).length;
      const label = p.name === currentProvider ? `✓ ${p.name} (${count})` : `${p.name} (${count})`;
      return [{ text: label, callback_data: `mprov2:${slot}:${p.name}` }];
    });
    buttons.push([{ text: "← Back", callback_data: "mslot:professor" }]);
    await api.sendMessage(chatId, `🔌 Provider for ${slotLabel}:`, { reply_markup: { inline_keyboard: buttons } });

  } else if (data.startsWith("mprov2:")) {
    const [, slot, providerName] = data.split(":");
    const { loadTransport } = await import("../../components/transport-config.js");
    const tc = loadTransport();
    const providerConfig = tc?.providers[providerName!];
    const entries = await buildModelEntries(providerName!, providerConfig);
    if (entries.length === 0) {
      // #1320: big un-curated pi-ai provider — defer to the modern TUI switcher + text escape.
      await api.sendMessage(chatId, `📋 No curated models for ${providerName} yet. Use the TUI to browse the full catalog, or \`/models quick <id>\`.`);
      return;
    }
    state._pendingSlot = slot;
    const slotLabel = slot === "professor" ? "Main" : slot!.replace("professor_fb", "Fb");
    state._modelPickerCache = entries.map(e => e.id);
    const buttons = entries.map((e, i) => [{ text: e.label, callback_data: `mset:${providerName}:${i}` }]);
    buttons.push([{ text: "← Back", callback_data: `mb:s:${slot}` }]);
    await api.sendMessage(chatId, `📋 Pick model for ${slotLabel}:`, { reply_markup: { inline_keyboard: buttons } });

  } else if (data.startsWith("mset:")) {
    const parts = data.split(":");
    const providerName = parts[1]!;
    const modelIdx = parseInt(parts[2]!, 10);
    const model = Number.isFinite(modelIdx) && state._modelPickerCache[modelIdx]
      ? state._modelPickerCache[modelIdx]!
      : parts.slice(2).join(":");
    const slot = state._pendingSlot ?? "main";
    state._pendingSlot = undefined;
    state._modelPickerCache = [];
    const { loadTransport, writeTransportConfig, resolveAgent, getModelsForProvider, validateProviderReady, formatValidationError } = await import("../../components/transport-config.js");
    const tc = loadTransport();
    if (!tc) { await api.sendMessage(chatId, "❌ transport.json not loaded"); return; }

    const providerConfig = tc.providers[providerName];
    if (!providerConfig) { await api.sendMessage(chatId, `❌ Provider ${providerName} not found`); return; }
    // #1311: pi-sourced models aren't in models.json — trust the picker cache for pi providers.
    if (!providerConfig.useProviderLib) {
      const validModels = getModelsForProvider(providerName);
      if (!validModels.some(m => m.id === model)) { await api.sendMessage(chatId, `❌ ${model} is not available on ${providerName}. Pick another.`); return; }
    }
    const validation = validateProviderReady(providerName, providerConfig, getEnv());
    if (!validation.ok) { await api.sendMessage(chatId, formatValidationError(providerName, validation)); return; }

    if (providerConfig?.transport === "api") {
      try {
        const endpoint = providerConfig.endpoint ?? "";
        const apiKey = getEnv().getApiKey(providerConfig.apiKeyEnv ?? "API_KEY");
        const headers: Record<string, string> = {};
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await fetch(`${endpoint}/models`, { headers, signal: AbortSignal.timeout(5000) });
        if (!res.ok) { await api.sendMessage(chatId, `⚠️ ${providerName} unreachable (${res.status}). Try another?`); return; }
      } catch (err) { logAndSwallow(TAG, "provider reachability check", err); await api.sendMessage(chatId, `⚠️ ${providerName} unreachable. Try another?`); return; }
    }

    const fbMatch = slot.match(/^fallback(\d+)$/);
    if (fbMatch) {
      const fbIndex = parseInt(fbMatch[1]!, 10) - 1;
      if (!tc.fallbacks) tc.fallbacks = [];
      tc.fallbacks[fbIndex] = { model, provider: providerName };
      const { cleanDemotedModels } = await import("../../components/transport-config.js");
      cleanDemotedModels(tc, model);
      writeTransportConfig(tc, `fallback ${fbIndex + 1} → ${model} (${providerName})`);
      await api.sendMessage(chatId, `✓ Fallback ${fbIndex + 1} → ${model} (${providerName})`);
    } else {
      const oldProvider = tc.agents[slot]?.provider;
      tc.agents[slot] = { ...tc.agents[slot]!, model, provider: providerName };
      const { cleanDemotedModels } = await import("../../components/transport-config.js");
      cleanDemotedModels(tc, model);
      writeTransportConfig(tc, `${slot} → ${model} (${providerName})`);

      const providerChanged = oldProvider !== providerName;
      const isMain = slot === "main";

      let oldType: string | undefined;
      let newType: string | undefined;
      let newResolved: ReturnType<typeof resolveAgent> | undefined;
      if (isMain && providerChanged) {
        const oldResolved = resolveAgent("_old", { ...tc, agents: { ...tc.agents, _old: { model: "", provider: oldProvider! } } });
        newResolved = resolveAgent("_new", { ...tc, agents: { ...tc.agents, _new: { model, provider: providerName } } });
        oldType = oldResolved?.provider.transport ?? "api";
        newType = newResolved?.provider.transport ?? "api";
        if (oldType !== newType) {
          const resetAgents: string[] = [];
          for (const [a, assignment] of Object.entries(tc.agents)) {
            if (a === "main") continue;
            const ap = tc.providers[assignment.provider];
            if (ap && ap.transport !== newType) { tc.agents[a] = { model, provider: providerName }; resetAgents.push(a); }
          }
          if (resetAgents.length > 0) writeTransportConfig(tc, `cascade: ${resetAgents.join(", ")} → ${providerName}`);
        }
      }

      if (isMain && !providerChanged && "setModel" in deps.transport) {
        await (deps.transport as unknown as { setModel: (m: string) => Promise<void> }).setModel(model);
        await api.sendMessage(chatId, `✓ Switched to ${model}`);
      } else if (isMain && providerChanged && oldType === newType && "switchProvider" in deps.transport) {
        try {
          const { FallbackPolicy } = await import("../../components/transport/fallback-policy.js");
          const { ModelHealthRegistry } = await import("../../components/transport/model-health-registry.js");
          const apiKey = getEnv().getApiKey(newResolved?.provider.apiKeyEnv ?? "API_KEY");
          const candidates: Array<{ endpoint: string; apiKey?: string; model: string; maxContext: number; source: CandidateSource }> = [{ endpoint: newResolved!.provider.endpoint!, apiKey, model, maxContext: newResolved!.contextWindow, source: "primary" }];
          for (const fb of (tc.fallbacks ?? [])) {
            const fbRes = resolveAgent("_fb", { ...tc, agents: { ...tc.agents, _fb: { model: fb.model, provider: fb.provider } } });
            if (fbRes) candidates.push({ endpoint: fbRes.provider.endpoint!, apiKey: fbRes.provider.apiKeyEnv ? getEnv().getApiKey(fbRes.provider.apiKeyEnv) : apiKey, model: fb.model, maxContext: fbRes.contextWindow, source: "agent_fallback" });
          }
          const registry = (deps.transport as unknown as { policy?: { registry: InstanceType<typeof ModelHealthRegistry> } }).policy?.registry ?? new ModelHealthRegistry();
          const policy = new FallbackPolicy(candidates, registry);
          (deps.transport as unknown as { switchProvider: (o: unknown) => void }).switchProvider({ endpoint: newResolved!.provider.endpoint!, apiKey, model, maxContext: newResolved!.contextWindow, policy });
        } catch (err) {
          await api.sendMessage(chatId, `⚠️ Hot swap failed: ${err instanceof Error ? err.message : String(err)}. Use /reset to apply.`);
          return;
        }
        try { await api.sendMessage(chatId, `✓ Switched to ${model} (${providerName})`); } catch (err) { logAndSwallow(TAG, "sendMessage model switch confirm", err); }
      } else if (isProfessor && providerChanged) {
        const cascadeNote = oldType !== newType ? " Subagents also reset." : "";
        try {
          if (deps.pipeline.rebuildTransport) await deps.pipeline.rebuildTransport();
          await deps.resetSessionForModelSwitch(chatId, "cross-transport-switch");
          await api.sendMessage(chatId, `🔄 Switched to ${model} (${providerName}). Transport rebuilt.${cascadeNote}`);
        } catch (err) {
          await api.sendMessage(chatId, `⚠️ Transport rebuild failed: ${err instanceof Error ? err.message : String(err)}. Try /reset manually.`);
        }
      } else {
        await api.sendMessage(chatId, `✓ ${agentKey} → ${model} (${providerName})`);
      }
    }
  } else if (data.startsWith("model:")) {
    const newModel = data.slice(6);
    if ("setModel" in deps.transport && typeof deps.transport.setModel === "function") {
      try {
        await deps.transport.setModel(newModel);
        await deps.resetSessionForModelSwitch(chatId);
        await api.sendMessage(chatId, `🤖 Model switched → ${newModel}`);
      } catch (err) {
        await api.sendMessage(chatId, `❌ Model switch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
