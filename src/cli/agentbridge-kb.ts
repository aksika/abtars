#!/usr/bin/env node
/**
 * agentbridge-kb — CLI for agent-initiated knowledge base operations.
 *
 * Wraps the NotebookLM CLI to provide query, notebook management,
 * and source management via the Layer 6 knowledge base.
 *
 * Usage:
 *   agentbridge-kb query --query "What does the RFC say?" --chat-id 123
 *   agentbridge-kb query --query "auth requirements" --notebook research --chat-id 123
 *   agentbridge-kb notebooks list
 *   agentbridge-kb notebooks create --name "research" --description "Research papers"
 *   agentbridge-kb sources list --notebook research
 *   agentbridge-kb sources add --notebook research --type url --identifier https://example.com
 *   agentbridge-kb sources remove --notebook research --source-id abc123
 */

import { loadNotebookLMConfig } from "../components/notebooklm-config.js";
import { NotebookLMClient } from "../components/notebooklm-client.js";
import { NotebookRegistry } from "../components/notebook-registry.js";
import type { SourceDescriptor } from "../types/index.js";

export type Subcommand =
  | "query"
  | "notebooks list"
  | "notebooks create"
  | "sources list"
  | "sources add"
  | "sources remove";

export type RawArgs = {
  subcommand: Subcommand | null;
  query?: string;
  notebook?: string;
  chatId?: string;
  name?: string;
  description?: string;
  type?: string;
  identifier?: string;
  sourceId?: string;
};

const VALID_SUBCOMMANDS = new Set<string>([
  "query",
  "notebooks list",
  "notebooks create",
  "sources list",
  "sources add",
  "sources remove",
]);

export function parseArgs(argv: string[]): RawArgs {
  const args = argv.slice(2);
  const parsed: RawArgs = { subcommand: null };

  // Detect subcommand: first 1-2 positional args
  if (args.length === 0) return parsed;

  const first = args[0];
  if (first === "query") {
    parsed.subcommand = "query";
  } else if (first === "notebooks" || first === "sources") {
    const second = args[1];
    const candidate = `${first} ${second}`;
    if (VALID_SUBCOMMANDS.has(candidate)) {
      parsed.subcommand = candidate as Subcommand;
    }
  }

  // Parse flags
  const startIdx = parsed.subcommand?.includes(" ") ? 2 : 1;
  for (let i = startIdx; i < args.length; i++) {
    switch (args[i]) {
      case "--query": parsed.query = args[++i] ?? ""; break;
      case "--notebook": parsed.notebook = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--name": parsed.name = args[++i] ?? ""; break;
      case "--description": parsed.description = args[++i] ?? ""; break;
      case "--type": parsed.type = args[++i] ?? ""; break;
      case "--identifier": parsed.identifier = args[++i] ?? ""; break;
      case "--source-id": parsed.sourceId = args[++i] ?? ""; break;
    }
  }

  return parsed;
}

export function validateArgs(raw: RawArgs): { ok: true } | { ok: false; error: string } {
  if (!raw.subcommand) {
    return { ok: false, error: "Unknown subcommand. Valid: query, notebooks list, notebooks create, sources list, sources add, sources remove" };
  }

  switch (raw.subcommand) {
    case "query":
      if (!raw.query) return { ok: false, error: "Missing required parameter: --query" };
      if (!raw.chatId) return { ok: false, error: "Missing required parameter: --chat-id" };
      break;
    case "notebooks create":
      if (!raw.name) return { ok: false, error: "Missing required parameter: --name" };
      break;
    case "sources list":
      if (!raw.notebook) return { ok: false, error: "Missing required parameter: --notebook" };
      break;
    case "sources add":
      if (!raw.notebook) return { ok: false, error: "Missing required parameter: --notebook" };
      if (!raw.type) return { ok: false, error: "Missing required parameter: --type" };
      if (!raw.identifier) return { ok: false, error: "Missing required parameter: --identifier" };
      break;
    case "sources remove":
      if (!raw.notebook) return { ok: false, error: "Missing required parameter: --notebook" };
      if (!raw.sourceId) return { ok: false, error: "Missing required parameter: --source-id" };
      break;
  }

  return { ok: true };
}

function jsonOut(data: unknown): void {
  console.log(JSON.stringify(data));
}

function jsonError(error: string): void {
  console.log(JSON.stringify({ error }));
}

async function main() {
  const raw = parseArgs(process.argv);
  const validation = validateArgs(raw);

  if (!validation.ok) {
    jsonError(validation.error);
    return;
  }

  const config = loadNotebookLMConfig();
  if (!config.enabled) {
    jsonError("NotebookLM is disabled (NOTEBOOKLM_ENABLED is not true)");
    return;
  }

  const client = new NotebookLMClient(config);
  const registry = new NotebookRegistry();

  try {
    await client.initialize();
  } catch (err) {
    jsonError(`Failed to initialize NotebookLM client: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    switch (raw.subcommand) {
      case "query": {
        const notebookName = raw.notebook || config.defaultNotebook;
        if (!notebookName) {
          jsonError("No notebook specified and no default notebook configured (NOTEBOOKLM_DEFAULT_NOTEBOOK)");
          return;
        }
        const notebookId = registry.resolve(notebookName);
        if (!notebookId) {
          jsonError(`Notebook "${notebookName}" not found. Available: ${registry.availableNames().join(", ") || "(none)"}`);
          return;
        }
        const result = await client.query(notebookId, raw.query!);
        if (!result.ok) { jsonError(result.error); return; }
        jsonOut({
          answer: result.data.answer,
          citations: result.data.citations,
          confidence: result.data.confidence,
          notebookName,
          cached: false,
        });
        break;
      }

      case "notebooks list": {
        const entries = registry.list();
        jsonOut(entries);
        break;
      }

      case "notebooks create": {
        const createResult = await client.createNotebook(raw.name!);
        if (!createResult.ok) { jsonError(createResult.error); return; }
        registry.register({
          name: raw.name!,
          notebookId: createResult.data,
          description: raw.description || "",
          createdAt: Date.now(),
          sourceCount: 0,
        });
        jsonOut({ name: raw.name, notebookId: createResult.data, created: true });
        break;
      }

      case "sources list": {
        const nbId = registry.resolve(raw.notebook!);
        if (!nbId) {
          jsonError(`Notebook "${raw.notebook}" not found. Available: ${registry.availableNames().join(", ") || "(none)"}`);
          return;
        }
        const sourcesResult = await client.listSources(nbId);
        if (!sourcesResult.ok) { jsonError(sourcesResult.error); return; }
        jsonOut(sourcesResult.data);
        break;
      }

      case "sources add": {
        const nbId = registry.resolve(raw.notebook!);
        if (!nbId) {
          jsonError(`Notebook "${raw.notebook}" not found. Available: ${registry.availableNames().join(", ") || "(none)"}`);
          return;
        }
        const validTypes = new Set(["url", "pdf", "text", "markdown"]);
        if (!validTypes.has(raw.type!)) {
          jsonError(`Invalid source type "${raw.type}". Valid: url, pdf, text, markdown`);
          return;
        }
        const source: SourceDescriptor = { type: raw.type as SourceDescriptor["type"], identifier: raw.identifier! };
        const addResult = await client.addSource(nbId, source);
        if (!addResult.ok) { jsonError(addResult.error); return; }
        jsonOut(addResult.data);
        break;
      }

      case "sources remove": {
        const nbId = registry.resolve(raw.notebook!);
        if (!nbId) {
          jsonError(`Notebook "${raw.notebook}" not found. Available: ${registry.availableNames().join(", ") || "(none)"}`);
          return;
        }
        const delResult = await client.deleteSource(nbId, raw.sourceId!);
        if (!delResult.ok) { jsonError(delResult.error); return; }
        jsonOut({ removed: true, sourceId: raw.sourceId });
        break;
      }
    }
  } catch (err) {
    jsonError(err instanceof Error ? err.message : String(err));
  } finally {
    client.close();
  }
}

// Only run when executed as a script
const isDirectRun = process.argv[1]?.endsWith("agentbridge-kb.ts") ||
  process.argv[1]?.endsWith("agentbridge-kb.js");
if (isDirectRun) {
  main();
}
