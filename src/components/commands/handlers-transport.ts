import { logInfo, logError } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { CommandContext } from "./types.js";
import { triggerResetSession} from "./registry.js";

const TAG = "cmd";

export async function handleNewReset(text: string, ctx: CommandContext): Promise<boolean> {
  const isResetDefault = text.trim().toLowerCase() === "/reset default";

  if (isResetDefault) {
    const { resetToDefaults } = await import("../transport-config.js");
    resetToDefaults();
  } else {
    try {
      await triggerResetSession(ctx);
    } catch (err) {
      await ctx.reply(`⚠️ Transport rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }

  // End active session via session manager → fresh Main
  ctx.sessionManager.endSession(ctx.userId, ctx.platform);
  const activeId = ctx.sessionManager.getActiveSessionId(ctx.userId, ctx.platform);
  await ctx.transport.resetSession(activeId);

  const label = isResetDefault ? "🔄 Reset to defaults." : "🔄 Transport reloaded.";
  await ctx.reply(label);

  // Greet in the new session (#968)
  const newSession = ctx.sessionManager.getActiveSession(ctx.userId, ctx.platform);
  ctx.sessionManager.greetSession(newSession, ctx.chatId, ctx.userId);

  logInfo(TAG, `Reset session → ${activeId} (${ctx.platform})`);
  return true;
}

export async function handleCompact(_text: string, ctx: CommandContext): Promise<boolean> {
  try {
    // #1022: compaction only for A/C session types (hard requirement).
    const { isCompactable } = await import("../spin-types.js");
    if (!isCompactable(ctx.sessionKey)) {
      await ctx.reply("Compaction not available for this session.");
      return true;
    }
    // Context engine compaction — force compact via transport's orchestrator
    const transport = ctx.transport as { contextOrchestrator?: { forceCompact(chatId: string, budget: number): Promise<import("abmind").CompactionResult> }; config?: { maxContext: number } };
    if (transport.contextOrchestrator) {
      const budget = (transport as any).config?.maxContext ?? 200000;
      const result = await transport.contextOrchestrator.forceCompact(ctx.sessionKey, budget);
      if (result.skipped) {
        await ctx.reply("Compaction skipped (recent passes saved little — retry in ~30 min).");
      } else if (result.ok) {
        const pct = Math.round(result.savingsPct * 100);
        await ctx.reply(`Compaction complete. ${result.tokensBefore}→${result.tokensAfter} tokens (${pct}% saved).`);
      } else {
        await ctx.reply("Nothing to compact.");
      }
    } else {
      await ctx.reply("Context engine not active for this transport.");
    }
  } catch (err) {
    logError(TAG, "Manual compaction failed", err);
    await ctx.reply("Compaction failed.");
  }
  return true;
}

export async function handleEmergencyAlias(_text: string, ctx: CommandContext): Promise<boolean> {
  return handleModels("/model emergency", ctx);
}

export async function handleModels(text: string, ctx: CommandContext): Promise<boolean> {
  const { loadTransport, resolveAgent, getModelsForProvider } = await import("../transport-config.js");
  const tc = loadTransport();
  const prof = tc ? resolveAgent("main", tc) : null;
  const currentModel = ("currentModel" in ctx.transport
    ? (ctx.transport as unknown as { currentModel: string }).currentModel
    : undefined) ?? prof?.model ?? "unknown";

  const arg = text.replace(/^\/(models?)\s*/i, "").trim().toLowerCase();

  // #1447: embedded Pi has no private emergency engine. #1467 will provide
  // the explicit ACP/tmux route override in transport.json.
  if (arg === "emergency" || arg === "hailmary") {
    await ctx.reply("❌ Embedded Pi emergency switching is removed. Select the ACP/tmux emergency route after the #1467 transport.json update.");
    return true;
  }

  // /models restore — swap transport.json ↔ transport.json.old (undo last switch)
  if (arg === "restore") {
    const { restorePrevious } = await import("../transport-config.js");
    const result = restorePrevious();
    if (!result.ok) { await ctx.reply(`❌ ${result.error}`); return true; }
    await ctx.reply("🔄 Restored previous config.");
    return true;
  }

  // /models default — factory reset from transport.default.json
  if (arg === "default") {
    const { resetToDefaults } = await import("../transport-config.js");
    if (!resetToDefaults()) { await ctx.reply("❌ Factory config not found — run abtars install to restore."); return true; }
    await ctx.reply("🔄 Factory config restored.");
    return true;
  }

  // /models health reset / primary / reset — reset model health buckets
  if (arg === "health reset" || arg === "primary" || arg === "reset") {
    const t = ctx.transport as unknown as {
      policy?: { registry: { resetAll: () => void } };
    };
    if (t.policy?.registry) {
      t.policy.registry.resetAll();
      await ctx.reply("Model health reset — all models available (sticky credits/auth cleared).");
    } else {
      await ctx.reply("No fallback policy configured.");
    }
    return true;
  }

  // /model doctor — probe all models under current transport
  if (arg === "doctor") {
    if (!prof) { await ctx.reply("❌ No transport configured."); return true; }
    const endpoint = prof.provider.endpoint ?? "http://localhost:11434/v1";
    const apiKey = prof.provider.apiKeyEnv ? (await import("../env-schema.js")).getEnv().getApiKey(prof.provider.apiKeyEnv) : undefined;

    // Collect all models under this provider
    const models = new Set<string>();
    for (const [, agent] of Object.entries(tc!.agents)) {
      if (agent.provider === prof.providerName) models.add(agent.model);
    }
    for (const fb of tc!.fallbacks ?? []) {
      if (fb.provider === prof.providerName) models.add(fb.model);
    }
    if (tc!.hailMary?.provider === prof.providerName) models.add(tc!.hailMary.model);

    await ctx.reply(`🩺 Checking ${models.size} models on ${prof.providerName}...`);
    const results: string[] = [];
    const { loadModels } = await import("../transport-config.js");
    const catalog = loadModels();

    for (const model of models) {
      try {
        const res = await fetch(`${endpoint}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          results.push(`✓ ${model} — alive`);
          if (catalog[model]) catalog[model]!.status = "alive";
        } else {
          const body = await res.text().catch(err => { logAndSwallow(TAG, "read model probe error body", err); return ""; });
          const short = body.slice(0, 80).replace(/\n/g, " ");
          const status = res.status === 404 ? "dead" : res.status === 403 ? "subscription" : res.status === 429 ? "rate_limited" : "error";
          results.push(`❌ ${model} — ${status} (${res.status}: ${short})`);
          if (catalog[model]) { catalog[model]!.status = status as any; (catalog[model] as any).error = `${res.status}: ${short}`; }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`⚠️ ${model} — timeout/error (${msg.slice(0, 60)})`);
        if (catalog[model]) { catalog[model]!.status = "dead" as any; (catalog[model] as any).error = msg.slice(0, 80); }
      }
      if (catalog[model]) (catalog[model] as any).lastChecked = new Date().toISOString();
    }

    // Write updated catalog
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { configDir } = await import("../transport-config.js");
    writeFileSync(join(configDir(), "models.json"), JSON.stringify(catalog, null, 2) + "\n");

    await ctx.reply(`🩺 Model Health:\n${results.join("\n")}`);
    return true;
  }

  // /models quick <model> — instant switch
  if (arg.startsWith("quick ") || arg.startsWith("switch ")) {
    const newModel = arg.split(" ").slice(1).join(" ").trim();
    if (!newModel) { await ctx.reply("Usage: /models quick <model>"); return true; }
    if (!tc || !prof) { await ctx.reply("❌ transport.json not loaded"); return true; }

    // Check if model is available on current provider
    const models = getModelsForProvider(prof.providerName);
    const match = models.find(m => m.id === newModel);
    if (!match) {
      await ctx.reply(`❌ ${newModel} not available on ${prof.providerName}. Use /models change to switch provider.`);
      return true;
    }

    // #367 — validate the provider (same one we're on) is still ready.
    {
      const { validateProviderReady, formatValidationError } = await import("../transport-config.js");
      const { getEnv } = await import("../env-schema.js");
      const result = validateProviderReady(prof.providerName, prof.provider, getEnv());
      if (!result.ok) { await ctx.reply(formatValidationError(prof.providerName, result)); return true; }
    }

    // Build independent candidate — never mutate the cached object
    const candidate = JSON.parse(JSON.stringify(tc)) as typeof tc;
    candidate.agents["main"]!.model = newModel;
    const { cleanDemotedModels, writeTransportConfig } = await import("../transport-config.js");
    cleanDemotedModels(candidate, newModel);
    const result = writeTransportConfig(candidate, `main model → ${newModel}`);
    if (!result.ok) {
      await ctx.reply(`❌ Cannot switch: ${result.issues.map(i => i.reason).join("; ")}`);
      return true;
    }
    if ("setModel" in ctx.transport) {
      await (ctx.transport as unknown as { setModel: (m: string) => Promise<void> }).setModel(newModel);
    }
    await ctx.reply(`✓ Switched to ${newModel}`);
    return true;
  }

  // /models list [provider] — text-based discovery for all platforms
  if (arg === "list" || arg.startsWith("list ")) {
    const providerArg = arg.slice(5).trim();
    const { getAvailableProviders, getModelsForProvider: getModels } = await import("../transport-config.js");
    if (!tc) { await ctx.reply("❌ transport.json not loaded"); return true; }

    if (!providerArg) {
      // List all providers
      const providers = getAvailableProviders(tc);
      const lines = ["🔌 Providers:"];
      for (const p of providers) {
        const count = getModels(p.name).length;
        lines.push(`  • ${p.name} (${p.config.transport})${count > 0 ? ` — ${count} models` : ""}`);
      }
      lines.push("\nUse /model list <provider> to see models.");
      await ctx.reply(lines.join("\n"));
    } else {
      // List models for a specific provider
      const models = getModels(providerArg);
      if (models.length === 0) { await ctx.reply(`❌ No models found for provider "${providerArg}"`); return true; }
      const lines = [`Models on ${providerArg}:`];
      for (const m of models) {
        const current = m.id === currentModel ? " ✓" : "";
        lines.push(`  • ${m.id}${current}`);
      }
      lines.push(`\nUse /model quick <name> to switch.`);
      await ctx.reply(lines.join("\n"));
    }
    return true;
  }

  // /models change — 4-stage picker (agent→provider→slot→model)
  if (arg === "change") {
    if (ctx.platform !== "telegram") {
      await ctx.reply("🤖 Use /model list to discover, /model quick <model> to switch.");
      return true;
    }
    const AGENT_LABELS: Array<{ key: string; label: string }> = [
      { key: "main", label: "Main" },
      { key: "dreamy", label: "Dreamy (sleep)" },
      { key: "browsie", label: "Browsie (browse)" },
      { key: "cody", label: "Cody (coding)" },
    ];
    const buttons = AGENT_LABELS.map(a => [{ text: a.label, callback_data: `mslot:${a.key}` }]);
    buttons.push([{ text: "← Cancel", callback_data: "mb:" }]);
    await ctx.reply("🤖 Which agent to change?", { reply_markup: { inline_keyboard: buttons } });
    return true;
  }

  // /model provider <name> — global provider switch (replaces old picker "Provider" option)
  if (arg.startsWith("provider ")) {
    const providerName = arg.slice(9).trim();
    if (!tc || !prof) { await ctx.reply("❌ transport.json not loaded"); return true; }
    const provider = tc.providers[providerName];
    if (!provider) { await ctx.reply(`❌ Provider "${providerName}" not found. Available: ${Object.keys(tc.providers).join(", ")}`); return true; }
    const { validateProviderReady, formatValidationError, loadProviderDefaults } = await import("../transport-config.js");
    const { getEnv } = await import("../env-schema.js");
    const validation = validateProviderReady(providerName, provider, getEnv());
    if (!validation.ok) { await ctx.reply(formatValidationError(providerName, validation)); return true; }
    const defaults = loadProviderDefaults(providerName);
    if (defaults?.main) {
      const candidate = JSON.parse(JSON.stringify(tc)) as typeof tc;
      candidate.agents["main"] = { model: defaults.main.model, provider: providerName };
      for (const role of ["dreamy", "browsie", "cody"] as const) {
        candidate.agents[role] = { model: defaults[role]?.model ?? defaults.main.model, provider: providerName };
      }
      const { writeTransportConfig } = await import("../transport-config.js");
      const result = writeTransportConfig(candidate, `global provider → ${providerName}`);
      if (!result.ok) {
        await ctx.reply(`❌ Cannot switch to ${providerName}: ${result.issues.map(i => i.reason).join("; ")}`);
        return true;
      }
    } else {
      // #1415: no provider defaults — don't retain old provider's model IDs
      await ctx.reply(`❌ ${providerName} has no model defaults. Use /model list ${providerName} and /model quick <model> to pick a compatible model.`);
      return true;
    }
    await ctx.reply(`✓ All agents → ${providerName}. Use /reset to apply.`);
    return true;
  }

  // /models (no arg) — merged status: model + transport + agents
  // #1416: live snapshot from getRuntimeStatus() — shared formatter.
  const { resolveRuntimeStatus, formatRuntimeRoute } = await import("../transport/runtime-status.js");
  const liveStatus = resolveRuntimeStatus(ctx.transport as any, {
    route: tc?.route,
    provider: prof?.providerName,
    model: prof?.model,
  });
  const ctxPct = ctx.transport.contextPercent >= 0 ? `${ctx.transport.contextPercent}%` : "n/a";
  const statusMark = ctx.transport.isReady ? "✓" : "✗";

  const lines = [
    `🔌 Transport: ${formatRuntimeRoute(liveStatus)} ${statusMark}`,
    `Model: ${liveStatus.model ?? currentModel}`,
    `Context: ${ctxPct}`,
    "",
    "Agents:",
  ];
  const agents = ["main", "dreamy", "browsie", "cody"] as const;
  const names: Record<string, string> = { main: "Main", dreamy: "Dreamy", browsie: "Browsie", cody: "Cody" };
  for (const a of agents) {
    const r = tc ? resolveAgent(a, tc) : null;
    let line = `  ${names[a]}: ${r?.model ?? "unknown"} (${r?.providerName ?? "?"}, ${r?.provider.transport ?? "?"})`;
    if (a === "main") {
      const fbLines = (tc?.fallbacks ?? []).map((f, i) => {
        if ((f as any).demoted) return null;
        return `    ↳ fb${i + 1}: ${f.model} (${f.provider})`;
      }).filter(Boolean).join("\n");
      if (fbLines) line += "\n" + fbLines;
    }
    lines.push(line);
  }
  if (tc?.fallbacks?.length) {
    lines.push(`\nFallback chain: ${tc.fallbacks.map(f => f.model).join(" → ")}`);
  }
  // #1386: Show effective candidate order from the transport's policy
  const transport = ctx.transport as unknown as { policy?: { candidates: Array<{ model: string; endpoint: string; source: string }> } };
  if (transport.policy?.candidates && transport.policy.candidates.length > 1) {
    const { formatCandidateChain } = await import("../transport/model-candidates.js");
    lines.push(`\nEffective chain:\n${formatCandidateChain(transport.policy.candidates as any)}`);
  }
  if (ctx.hailMary) {
    lines.push(`hailMary: ${ctx.hailMary.model} `);
  }
  lines.push("\nUse /models change to switch.");
  await ctx.reply(lines.join("\n"));
  return true;
}

// #1276: /effort (primary) + /thinking (alias). Both names route here via
// registerExact in commands/index.ts. The arg regex strips the command word
// for either name. The level set is pi-ai's verbatim (off|low|medium|high|xhigh)
// — see #1311 for the transport-side wiring.
//
// `off` is an effort level, NOT a display-toggle alias. We dropped the prior
// `on`/`off` display aliases (frees `off` for the effort branch) — bare
// `/effort` still echoes current state, `/effort show`/`/effort hide` toggle
// the display only.
export async function handleEffort(text: string, ctx: CommandContext): Promise<boolean> {
  const arg = text.replace(/^\/(?:effort|thinking)\s*/i, "").trim().toLowerCase();

  if (arg === "show") {
    await ctx.reply("Reasoning display: on (Pi transport)");
  } else if (arg === "hide") {
    await ctx.reply("Reasoning display: off (Pi transport)");
  } else if (["off", "low", "medium", "high", "xhigh"].includes(arg)) {
    await ctx.reply(`Reasoning effort: ${arg} (Pi transport)`);
  } else {
    await ctx.reply("Reasoning effort via Pi model config. Options: off, low, medium, high, xhigh.");
  }
  return true;
}

export async function handleContinue(_text: string, ctx: CommandContext): Promise<boolean> {
  // #1271: /continue goes through spin() continuation (model-call chokepoint)
  const { result: response } = await ctx.sessionManager.spin({
    type: "A", sessionId: ctx.sessionKey,
    prompt: "[SYSTEM] Something went wrong during your previous response. Continue from where you left off.",
    userId: ctx.userId, await: true,
  });
  if (response) await ctx.reply(response);
  return true;
}

// ── /route handler (#1418) ───────────────────────────────────────────────────

export async function handleRoute(args: string, ctx: CommandContext): Promise<boolean> {
  const { loadTransport, writeTransportConfig, providersForRoute, allAssignmentsMatchRoute, providerSupportsRoute } = await import("../transport-config.js");
  const tc = loadTransport();
  if (!tc) { await ctx.reply("❌ transport.json not loaded"); return true; }

  const arg = args.replace(/^\/route\s*/i, "").trim().toLowerCase();

  if (!arg) {
    const routeLabels: Record<string, string> = { "pi-ai": "pi-ai API", acp: "ACP" };
    await ctx.reply(
      `Current route: **${routeLabels[tc.route] ?? tc.route}**\n\n` +
      `Choose a route:\n${["pi-ai", "acp"].map(r => `• \`/route ${r}\` — ${routeLabels[r]}`).join("\n")}\n\n` +
      `_Provider filter: ${providersForRoute(tc, tc.route).length} compatible providers_`
    );
    return true;
  }

  const validRoutes = ["pi-ai", "acp"] as const;
  if (!validRoutes.includes(arg as any)) {
    await ctx.reply(`❌ Unknown route "${arg}". Choose: pi-ai or acp.`);
    return true;
  }

  const newRoute = arg as "pi-ai" | "acp";

  if (newRoute === tc.route) {
    await ctx.reply(`✓ Already on ${newRoute} route.`);
    return true;
  }

  if (allAssignmentsMatchRoute(tc, newRoute)) {
    const candidate = JSON.parse(JSON.stringify(tc)) as typeof tc;
    candidate.route = newRoute;
    const result = writeTransportConfig(candidate, `route → ${newRoute}`);
    if (!result.ok) {
      await ctx.reply(`❌ Cannot switch to ${newRoute}: ${result.issues.map(i => i.reason).join("; ")}`);
      return true;
    }
    await ctx.reply(`✓ Route switched to ${newRoute}. Use /reset to apply.`);
  } else {
    const incompatible: string[] = [];
    for (const [role, a] of Object.entries(tc.agents)) {
      const p = tc.providers[a.provider];
      if (!p || !providerSupportsRoute(p, newRoute)) incompatible.push(role);
    }
    for (let i = 0; i < (tc.fallbacks ?? []).length; i++) {
      const fb = tc.fallbacks![i]!;
      const p = tc.providers[fb.provider];
      if (!p || !providerSupportsRoute(p, newRoute)) incompatible.push(`fallback[${i}]`);
    }
    await ctx.reply(
      `❌ Cannot switch to ${newRoute}: incompatible assignments found.\n` +
      `Incompatible: ${incompatible.join(", ") || "none"}\n` +
      `Use the interactive /model change picker to reassign them, or edit transport.json manually.`
    );
  }
  return true;
}
