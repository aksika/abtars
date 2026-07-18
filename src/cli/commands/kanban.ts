/**
 * kanban.ts — `abtars kanban create` CLI (#955).
 *
 * Creates a dispatchable kanban card by POSTing to the local Agent API.
 * Reads goal from --goal-file or stdin when --goal is not provided.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_API_PORT_FILE = join(homedir(), ".abtars", "state", "agent-api.port");

function readPort(): number {
  try {
    if (existsSync(AGENT_API_PORT_FILE)) {
      return parseInt(readFileSync(AGENT_API_PORT_FILE, "utf-8").trim(), 10);
    }
  } catch {}
  return 0;
}

export async function kanban(args: string[]): Promise<number> {
  const subcommand = args[0] ?? "";
  const flags = new Map<string, string | boolean>();
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      if (eqIdx > 2) {
        flags.set(a.slice(2, eqIdx), a.slice(eqIdx + 1));
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    }
  }

  if (subcommand !== "create") {
    process.stdout.write("Usage: abtars kanban create --title <title> --goal <goal> --type <SessionType> [--priority <p>] [--delivery-mode <m>]\n");
    process.stdout.write("  Create a dispatchable kanban card. Reads goal from stdin when --goal is omitted.\n");
    return 1;
  }

  const title = flags.get("title") as string | undefined;
  const type = flags.get("type") as string | undefined;
  const priority = flags.get("priority") as string | undefined;
  const deliveryMode = flags.get("delivery-mode") as string | undefined;
  const chatId = flags.get("chat-id") as string | undefined;
  const goalFile = flags.get("goal-file") as string | undefined;

  if (!title) {
    process.stderr.write("--title is required\n");
    return 1;
  }
  if (!type) {
    process.stderr.write("--type is required (SessionType: A/B/C/T/P/S/O/W/D/H)\n");
    return 1;
  }

  let goal = flags.get("goal") as string | undefined;
  if (!goal && goalFile) {
    try {
      goal = readFileSync(goalFile, "utf-8");
    } catch (err) {
      process.stderr.write(`Cannot read goal-file: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (!goal) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    goal = Buffer.concat(chunks).toString("utf-8").trim();
    if (!goal) {
      process.stderr.write("goal is required (provide via --goal, --goal-file, or stdin)\n");
      return 1;
    }
  }

  const port = readPort();
  if (!port) {
    process.stderr.write("Bridge Agent API port not found. Is the bridge running?\n");
    return 1;
  }

  const body = JSON.stringify({
    type,
    title,
    goal,
    source: "cli",
    priority: priority || "MEDIUM",
    delivery_mode: deliveryMode || "deliver",
    chat_id: chatId,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/kanban`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
      body,
    });
    const result = await response.json() as { ok: boolean; card_id?: number; status?: string; error?: string };
    if (result.ok) {
      process.stdout.write(`+ Card #${result.card_id} created (${result.status})\n`);
      return 0;
    }
    process.stderr.write(`Error: ${result.error}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`Connection failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
