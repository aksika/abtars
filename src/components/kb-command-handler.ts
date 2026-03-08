/**
 * Telegram /kb command handler for NotebookLM Layer 6 knowledge base.
 *
 * Subcommands:
 *   /kb list                — List registered notebooks
 *   /kb create <name>       — Create a new notebook
 *   /kb sources <notebook>  — List sources in a notebook
 *   /kb query <question>    — Query the default notebook
 */

import type { NotebookLMConfig } from "../types/index.js";
import type { NotebookLMClient } from "./notebooklm-client.js";
import type { NotebookRegistry } from "./notebook-registry.js";
import { logError } from "./logger.js";

const TAG = "KBCommand";

export type KBCommandResult = { text: string };

export async function handleKBCommand(
  args: string,
  config: NotebookLMConfig,
  client: NotebookLMClient | null,
  registry: NotebookRegistry | null,
): Promise<KBCommandResult> {
  if (!config.enabled || !client || !registry) {
    return { text: "📚 Knowledge base is disabled." };
  }

  const parts = args.split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";

  try {
    switch (sub) {
      case "list":
        return handleList(registry);
      case "create":
        return await handleCreate(parts.slice(1).join(" "), client, registry);
      case "sources":
        return await handleSources(parts[1] ?? "", client, registry);
      case "query":
        return await handleQuery(parts.slice(1).join(" "), config, client, registry);
      default:
        return { text: "Usage: /kb list | /kb create <name> | /kb sources <notebook> | /kb query <question>" };
    }
  } catch (err) {
    logError(TAG, "KB command failed", err);
    return { text: `❌ KB error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function handleList(registry: NotebookRegistry): KBCommandResult {
  const entries = registry.list();
  if (entries.length === 0) {
    return { text: "📚 No notebooks registered. Use /kb create <name> to create one." };
  }
  const lines = entries.map((e) => {
    const date = new Date(e.createdAt).toISOString().slice(0, 10);
    return `• ${e.name} — ${e.sourceCount} sources (${date})`;
  });
  return { text: `📚 Notebooks:\n\n${lines.join("\n")}` };
}

async function handleCreate(
  name: string,
  client: NotebookLMClient,
  registry: NotebookRegistry,
): Promise<KBCommandResult> {
  if (!name) return { text: "Usage: /kb create <name>" };
  const result = await client.createNotebook(name);
  if (!result.ok) return { text: `❌ ${result.error}` };
  registry.register({
    name,
    notebookId: result.data,
    description: "",
    createdAt: Date.now(),
    sourceCount: 0,
  });
  return { text: `✅ Notebook "${name}" created (${result.data})` };
}

async function handleSources(
  notebookName: string,
  client: NotebookLMClient,
  registry: NotebookRegistry,
): Promise<KBCommandResult> {
  if (!notebookName) return { text: "Usage: /kb sources <notebook-name>" };
  const nbId = registry.resolve(notebookName);
  if (!nbId) {
    return { text: `❌ Notebook "${notebookName}" not found. Available: ${registry.availableNames().join(", ") || "(none)"}` };
  }
  const result = await client.listSources(nbId);
  if (!result.ok) return { text: `❌ ${result.error}` };
  if (result.data.length === 0) return { text: `📄 No sources in "${notebookName}".` };
  const lines = result.data.map((s) => `• [${s.type}] ${s.name}`);
  return { text: `📄 Sources in "${notebookName}":\n\n${lines.join("\n")}` };
}

async function handleQuery(
  question: string,
  config: NotebookLMConfig,
  client: NotebookLMClient,
  registry: NotebookRegistry,
): Promise<KBCommandResult> {
  if (!question) return { text: "Usage: /kb query <question>" };
  const notebookName = config.defaultNotebook;
  if (!notebookName) return { text: "❌ No default notebook configured (NOTEBOOKLM_DEFAULT_NOTEBOOK)." };
  const nbId = registry.resolve(notebookName);
  if (!nbId) {
    return { text: `❌ Default notebook "${notebookName}" not found. Available: ${registry.availableNames().join(", ") || "(none)"}` };
  }
  const result = await client.query(nbId, question);
  if (!result.ok) return { text: `❌ ${result.error}` };
  const citations = result.data.citations.length > 0
    ? `\n\n📎 Sources: ${result.data.citations.map((c) => c.sourceName).join(", ")}`
    : "";
  return { text: `📚 ${result.data.answer}${citations}` };
}
