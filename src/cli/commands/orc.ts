import { printBanner } from './banner.js';
/**
 * cli/commands/orc.ts — Orc worker management CLI (#1011).
 * Calls bridge agent-api endpoints on localhost.
 */

const PORT = parseInt(process.env["AGENT_API_PORT"] || "3100", 10);
const BASE = `https://127.0.0.1:${PORT}/v1/orc`;

// Skip TLS verification for localhost self-signed cert
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

async function call(method: string, path: string, body?: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.text();
}

export async function orc(args: string[]): Promise<number> {
  await printBanner("orc");
  const sub = args[0];
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    if (args[i]?.startsWith("--") && args[i + 1]) {
      flags.set(args[i]!.slice(2), args[i + 1]!);
      i++;
    }
  }

  switch (sub) {
    case "spawn": {
      const goal = flags.get("goal");
      if (!goal) { console.log(JSON.stringify({ ok: false, error: "--goal required" })); return 1; }
      const result = await call("POST", "/spawn", { goal, title: flags.get("title"), priority: flags.get("priority") });
      console.log(result);
      return 0;
    }
    case "status": {
      const result = await call("GET", "/status");
      console.log(result);
      return 0;
    }
    case "cancel": {
      const cardId = flags.get("card");
      if (!cardId) { console.log(JSON.stringify({ ok: false, error: "--card required" })); return 1; }
      const result = await call("POST", "/cancel", { card_id: cardId });
      console.log(result);
      return 0;
    }
    case "delegate": {
      const peer = flags.get("peer");
      const goal = flags.get("goal");
      if (!peer || !goal) { console.log(JSON.stringify({ ok: false, error: "--peer and --goal required" })); return 1; }
      const result = await call("POST", "/delegate", { peer, goal, title: flags.get("title") });
      console.log(result);
      return 0;
    }
    default:
      console.log(JSON.stringify({ ok: false, error: "Usage: abtars orc spawn|status|cancel|delegate" }));
      return 1;
  }
}
