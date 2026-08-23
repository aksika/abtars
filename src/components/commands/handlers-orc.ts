/**
 * handlers-orc.ts — #1707 Task 5: owner-only /orc control surface for the
 * Orc circuit breakers. Reads the same durable fuse state the coordinator
 * consumes; resets clear only fuse state/counters and never resurrect a
 * terminal task occurrence or reuse a terminal run_id.
 */

import type { CommandContext } from "./types.js";
import { emitOrcAlert, muteOrcAlerts, orcAlertsMutedUntil, ORC_ALERT_MIN_INTERVAL_MS } from "../orc-project/orc-alerts.js";

function fmtFuse(f: { scope: string; openedAt: string | null; tripReason: string | null; generation: number }): string {
  if (f.openedAt) return `${f.scope}: OPEN since ${f.openedAt} (reason: ${f.tripReason ?? "unknown"}, gen ${f.generation})`;
  return `${f.scope}: closed (gen ${f.generation})`;
}

export async function handleOrc(text: string, ctx: CommandContext): Promise<boolean> {
  const arg = text.replace(/^\/orc\s*/i, "").trim().toLowerCase();
  const { OrcProjectRunStore } = await import("../orc-project/orc-project-run-store.js");
  const {
    CARD_FAILED_ATTEMPTS_LIMIT, CARD_FAILED_ATTEMPTS_WINDOW_MS,
    CARD_NO_PROGRESS_STARTS_LIMIT, CARD_NO_PROGRESS_WINDOW_MS,
    BRIDGE_STARTS_5M_LIMIT, BRIDGE_STARTS_5M_WINDOW_MS,
    BRIDGE_STARTS_HOUR_LIMIT, BRIDGE_STARTS_HOUR_WINDOW_MS,
    BRIDGE_ROWS_5M_LIMIT, BRIDGE_ROWS_5M_WINDOW_MS,
  } = await import("../orc-project/orc-project-contracts.js");

  try {
    if (arg === "" || arg === "status") {
      const store = new OrcProjectRunStore();
      const fuses = store.getFuseSnapshot();
      const counts = store.getBridgeWindowCounts();
      const open = fuses.filter(f => f.openedAt);
      const lines = [
        `Orc fuses: ${open.length} open / ${fuses.length} tracked`,
        ...open.map(fmtFuse),
        ...fuses.filter(f => !f.openedAt).slice(0, 10).map(fmtFuse),
        "",
        `Bridge windows: starts/5m=${counts.starts5m}/${BRIDGE_STARTS_5M_LIMIT} starts/1h=${counts.starts1h}/${BRIDGE_STARTS_HOUR_LIMIT} rows/5m=${counts.rows5m}/${BRIDGE_ROWS_5M_LIMIT}`,
        `Alert mute: ${orcAlertsMutedUntil() > Date.now() ? new Date(orcAlertsMutedUntil()).toISOString() : "off"}`,
      ];
      await ctx.reply(lines.join("\n"));
      return true;
    }

    if (arg === "limits") {
      await ctx.reply([
        "Orc fuse limits:",
        `  card: ${CARD_FAILED_ATTEMPTS_LIMIT} failed attempts/${Math.round(CARD_FAILED_ATTEMPTS_WINDOW_MS / 60_000)}m`,
        `  card: ${CARD_NO_PROGRESS_STARTS_LIMIT} no-progress starts/${Math.round(CARD_NO_PROGRESS_WINDOW_MS / 60_000)}m`,
        `  bridge: ${BRIDGE_STARTS_5M_LIMIT} starts/${Math.round(BRIDGE_STARTS_5M_WINDOW_MS / 60_000)}m`,
        `  bridge: ${BRIDGE_STARTS_HOUR_LIMIT} starts/${Math.round(BRIDGE_STARTS_HOUR_WINDOW_MS / 3_600_000)}h`,
        `  bridge: ${BRIDGE_ROWS_5M_LIMIT} new run rows/${Math.round(BRIDGE_ROWS_5M_WINDOW_MS / 60_000)}m`,
        `  alert min interval: ${Math.round(ORC_ALERT_MIN_INTERVAL_MS / 1000)}s`,
      ].join("\n"));
      return true;
    }

    if (arg.startsWith("reset project")) {
      const raw = arg.slice("reset project".length).trim();
      const cardId = parseInt(raw, 10);
      if (!Number.isInteger(cardId) || cardId <= 0) {
        await ctx.reply("Usage: /orc reset project <card-id>");
        return true;
      }
      new OrcProjectRunStore().resetProjectFuse(cardId);
      emitOrcAlert(`reset:card:${cardId}`, `[orc-fuse] operator reset scope=card:${cardId}`);
      await ctx.reply(`+ Card fuse reset for #${cardId}. Fuse/counters cleared; terminal task runs remain terminal.`);
      return true;
    }

    if (arg === "reset bridge") {
      new OrcProjectRunStore().resetBridgeFuse();
      emitOrcAlert("reset:bridge", "[orc-fuse] operator reset scope=bridge");
      await ctx.reply("+ Bridge fuse reset. New automatic claims admitted; stale events from the previous generation are harmless.");
      return true;
    }

    if (arg === "alerts status") {
      const until = orcAlertsMutedUntil();
      await ctx.reply(`Alerts: ${until > Date.now() ? `muted until ${new Date(until).toISOString()}` : "active"} (min interval ${Math.round(ORC_ALERT_MIN_INTERVAL_MS / 1000)}s per kind)`);
      return true;
    }

    if (arg === "alerts test") {
      const delivered = emitOrcAlert(`test:${Date.now()}`, "[orc-fuse] test alert — delivery path verified");
      await ctx.reply(delivered ? "+ Test alert delivered to the log." : "x Test alert suppressed (mute active or rate limit).");
      return true;
    }

    if (arg.startsWith("alerts mute")) {
      const raw = arg.slice("alerts mute".length).trim();
      const minutes = parseFloat(raw);
      if (!raw || !Number.isFinite(minutes) || minutes <= 0) {
        await ctx.reply("Usage: /orc alerts mute <minutes>");
        return true;
      }
      const until = muteOrcAlerts(minutes * 60_000);
      await ctx.reply(`~ Alerts muted until ${new Date(until).toISOString()} (trip recording unaffected).`);
      return true;
    }

    await ctx.reply([
      "Usage:",
      "  /orc status — fuse state, limits, window counts",
      "  /orc limits — configured values",
      "  /orc reset project <card-id>",
      "  /orc reset bridge",
      "  /orc alerts status | test | mute <minutes>",
    ].join("\n"));
    return true;
  } catch (err) {
    await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}
