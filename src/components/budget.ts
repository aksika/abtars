/**
 * budget.ts — Daily agent token/call budget enforcement.
 * Config: ~/.abtars/config/budget.json
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { logWarn } from "./logger.js";

interface AgentBudget { tokens?: number; calls?: number }
interface DailyBudget { [agent: string]: AgentBudget }
interface Counter { tokens: number; calls: number }

const counters = new Map<string, Counter>();
let lastResetDate = "";
const lastNotifiedAt = new Map<string, number>();

function ensureToday(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) { counters.clear(); lastResetDate = today; }
}

function loadBudget(): DailyBudget | null {
  try {
    const raw = readFileSync(join(abtarsHome(), "config", "budget.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed?.daily ?? null;
  } catch { return null; }
}

export function incrementBudgetCounter(agent: string, tokens: number): void {
  if (!agent) return;
  ensureToday();
  const c = counters.get(agent) ?? { tokens: 0, calls: 0 };
  c.tokens += tokens;
  c.calls += 1;
  counters.set(agent, c);
}

export function checkBudget(agent: string): { allowed: boolean; remaining: { tokens: number; calls: number }; limit: AgentBudget } {
  const budget = loadBudget();
  if (!budget || !budget[agent]) return { allowed: true, remaining: { tokens: Infinity, calls: Infinity }, limit: {} };
  ensureToday();
  const used = counters.get(agent) ?? { tokens: 0, calls: 0 };
  const limit = budget[agent];
  const tokenOk = !limit.tokens || used.tokens < limit.tokens * 1000;
  const callsOk = !limit.calls || used.calls < limit.calls;
  return {
    allowed: tokenOk && callsOk,
    remaining: { tokens: (limit.tokens ?? Infinity) * 1000 - used.tokens, calls: (limit.calls ?? Infinity) - used.calls },
    limit,
  };
}

export async function sendBudgetNotification(agent: string, reason: string): Promise<void> {
  const now = Date.now();
  const last = lastNotifiedAt.get(agent) ?? 0;
  if (now - last < 3_600_000) return; // max 1 per hour per agent
  lastNotifiedAt.set(agent, now);
  const used = counters.get(agent) ?? { tokens: 0, calls: 0 };
  const limit = loadBudget()?.[agent];
  const detail = reason === "token"
    ? `${Math.round(used.tokens / 1000)}K/${limit?.tokens ?? "?"}K tokens`
    : `${used.calls}/${limit?.calls ?? "?"} calls`;
  const msg = `x Budget: ${agent} hit daily ${reason} limit (${detail}). Paused until midnight.`;
  logWarn("budget", msg);
  try {
    const { sendToMainChat } = await import("./main-chat.js");
    await sendToMainChat({}, msg);
  } catch { /* best effort */ }
}

export function getBudgetStatus(): Array<{ agent: string; used: Counter; limit: AgentBudget }> {
  const budget = loadBudget();
  if (!budget) return [];
  ensureToday();
  return Object.entries(budget).map(([agent, limit]) => ({
    agent,
    used: counters.get(agent) ?? { tokens: 0, calls: 0 },
    limit,
  }));
}
