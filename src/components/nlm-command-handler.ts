/**
 * Telegram /nlm command handler for NotebookLM Layer 6 knowledge base.
 *
 * Subcommands:
 *   /nlm list                — List notebooks
 *   /nlm create <name>       — Create a new notebook
 *   /nlm sources <notebook>  — List sources in a notebook
 *   /nlm query <question>    — Query the default notebook
 */

import type { NotebookLMConfig } from "../types/index.js";
import type { NotebookLMClient } from "./notebooklm-client.js";
import type { NotebookRegistry } from "./notebook-registry.js";
import { logError } from "./logger.js";

const TAG = "NLMCommand";

export type NLMCommandResult = { text: string };

export async function handleNLMCommand(
  args: string,
  config: NotebookLMConfig,
  client: NotebookLMClient | null,
  registry: NotebookRegistry | null,
): Promise<NLMCommandResult> {
  if (!config.enabled || !client || !registry) {
    return { text: "📚 Knowledge base is disabled." };
  }

  const parts = args.split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";

  try {
    switch (sub) {
      case "list":
        return await handleList(client, registry);
      case "create":
        return await handleCreate(parts.slice(1).join(" "), client, registry);
      case "sources":
        return await handleSources(parts[1] ?? "", client, registry);
      case "query":
        return await handleQuery(parts.slice(1).join(" "), config, client, registry);
      default:
        return { text: "Usage: /nlm list | /nlm create <name> | /nlm sources <notebook> | /nlm query <question>" };
    }
  } catch (err) {
    logError(TAG, "KB command failed", err);
    return { text: `❌ KB error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function handleList(client: NotebookLMClient, registry: NotebookRegistry): Promise<NLMCommandResult> {
  const result = await client.listNotebooks();
  if (!result.ok) return { text: `❌ ${result.error}` };
  if (result.data.length === 0) return { text: "📚 No notebooks found." };
  const lines = result.data.map((n) => {
    const registered = registry.resolve(n.name) ? " ✓" : "";
    return `• ${n.name} (${n.id})${registered}`;
  });
  return { text: `📚 Notebooks:\n\n${lines.join("\n")}` };
}

async function handleCreate(
  name: string,
  client: NotebookLMClient,
  registry: NotebookRegistry,
): Promise<NLMCommandResult> {
  if (!name) return { text: "Usage: /nlm create <name>" };
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
): Promise<NLMCommandResult> {
  if (!notebookName) return { text: "Usage: /nlm sources <notebook-name>" };
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
): Promise<NLMCommandResult> {
  if (!question) return { text: "Usage: /nlm query <question>" };
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
