import { getEnv } from "./env-schema.js";
/**
 * Telegram /nlm command handler — calls `nlm` CLI directly.
 *
 * Subcommands:
 *   /nlm list                — List notebooks
 *   /nlm create <name>       — Create a new notebook
 *   /nlm sources <notebook>  — List sources in a notebook
 *   /nlm query <question>    — Query the default notebook
 */

import { execFile } from "node:child_process";
import { logError, logDebug, logInfo } from "./logger.js";

const TAG = "NLMCommand";
const TIMEOUT_MS = 120_000; // 2 minutes — NLM queries can be slow

export type NLMCommandResult = { text: string };

export type NLMConfig = {
  enabled: boolean;
  defaultNotebook: string; // notebook ID (not name)
};

export function loadNLMConfig(): NLMConfig {
  const raw = String(getEnv().notebooklmEnabled);
  return {
    enabled: raw === "true" || raw === "1",
    defaultNotebook: getEnv().notebooklmDefaultNotebook,
  };
}

/** Execute `nlm` CLI and return stdout. */
function nlmExec(args: string[]): Promise<{ ok: true; data: string } | { ok: false; error: string }> {
  const start = Date.now();
  logDebug(TAG, `nlm ${args.join(" ")}`);

  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      execFile("nlm", args, { signal: ac.signal, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        clearTimeout(timer);
        logDebug(TAG, `nlm completed in ${Date.now() - start}ms`);

        if (err) {
          if (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR") {
            resolve({ ok: false, error: `Timeout after ${TIMEOUT_MS / 1000}s` });
            return;
          }
          resolve({ ok: false, error: stderr?.trim() || err.message });
          return;
        }
        resolve({ ok: true, data: stdout.trim() });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export async function handleNLMCommand(args: string, config: NLMConfig): Promise<NLMCommandResult> {
  if (!config.enabled) {
    return { text: "📚 Knowledge base is disabled." };
  }

  const parts = args.split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";

  try {
    switch (sub) {
      case "list": return await handleList();
      case "create": return await handleCreate(parts.slice(1).join(" "));
      case "sources": return await handleSources(parts[1] ?? "");
      case "query": return await handleQuery(parts.slice(1).join(" "), config);
      default:
        return { text: "Usage: /nlm list | /nlm create <name> | /nlm sources <notebook-id> | /nlm query <question>" };
    }
  } catch (err) {
    logError(TAG, "NLM command failed", err);
    return { text: `❌ NLM error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function handleList(): Promise<NLMCommandResult> {
  const result = await nlmExec(["notebook", "list", "--json"]);
  if (!result.ok) return { text: `❌ ${result.error}` };

  try {
    const notebooks = JSON.parse(result.data);
    if (!Array.isArray(notebooks) || notebooks.length === 0) return { text: "📚 No notebooks found." };
    const lines = notebooks.map((n: Record<string, unknown>) =>
      `• ${n.title ?? n.name ?? "?"} (${n.id ?? n.notebook_id ?? "?"})`
    );
    return { text: `📚 Notebooks:\n\n${lines.join("\n")}` };
  } catch {
    // Non-JSON output — just return it as-is
    return { text: `📚 ${result.data}` };
  }
}

async function handleCreate(name: string): Promise<NLMCommandResult> {
  if (!name) return { text: "Usage: /nlm create <name>" };
  const result = await nlmExec(["notebook", "create", name, "--json"]);
  if (!result.ok) return { text: `❌ ${result.error}` };

  try {
    const parsed = JSON.parse(result.data);
    const id = parsed.notebook_id ?? parsed.id ?? "?";
    logInfo(TAG, `Created notebook "${name}" → ${id}`);
    return { text: `✅ Notebook "${name}" created (${id})` };
  } catch {
    return { text: `✅ ${result.data}` };
  }
}

async function handleSources(notebookId: string): Promise<NLMCommandResult> {
  if (!notebookId) return { text: "Usage: /nlm sources <notebook-id>" };
  const result = await nlmExec(["source", "list", notebookId, "--json"]);
  if (!result.ok) return { text: `❌ ${result.error}` };

  try {
    const sources = JSON.parse(result.data);
    if (!Array.isArray(sources) || sources.length === 0) return { text: `📄 No sources in notebook.` };
    const lines = sources.map((s: Record<string, unknown>) =>
      `• [${s.type ?? s.source_type ?? "?"}] ${s.title ?? s.name ?? "?"}`
    );
    return { text: `📄 Sources:\n\n${lines.join("\n")}` };
  } catch {
    return { text: `📄 ${result.data}` };
  }
}

async function handleQuery(question: string, config: NLMConfig): Promise<NLMCommandResult> {
  if (!question) return { text: "Usage: /nlm query <question>" };
  const nbId = config.defaultNotebook;
  if (!nbId) return { text: "❌ No default notebook configured (NOTEBOOKLM_DEFAULT_NOTEBOOK)." };

  const result = await nlmExec(["notebook", "query", nbId, question, "--json"]);
  if (!result.ok) return { text: `❌ ${result.error}` };

  try {
    const parsed = JSON.parse(result.data);
    const answer = parsed.answer ?? parsed.response ?? result.data;
    const sources = parsed.sources_used ?? parsed.citations ?? [];
    const citations = Array.isArray(sources) && sources.length > 0
      ? `\n\n📎 Sources: ${sources.map((s: Record<string, unknown>) => s.title ?? s.name ?? s.source_name ?? "?").join(", ")}`
      : "";
    logInfo(TAG, `Query OK — answerLen=${String(answer).length}`);
    return { text: `📚 ${answer}${citations}` };
  } catch {
    // Non-JSON — return raw output
    return { text: `📚 ${result.data}` };
  }
}
