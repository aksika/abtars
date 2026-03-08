import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logDebug, logError, logInfo } from "./logger.js";
import type {
  NotebookLMConfig,
  RAGResult,
  RAGCitation,
  NotebookInfo,
  SourceDescriptor,
  SourceInfo,
} from "../types/index.js";

const TAG = "NotebookLMClient";

type CLIResult<T> = { ok: true; data: T } | { ok: false; error: string };

export class NotebookLMClient {
  private readonly config: NotebookLMConfig;
  private readonly cache = new Map<string, { result: RAGResult; timestamp: number }>();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(config: NotebookLMConfig) {
    this.config = config;
  }

  /** Validate CLI path exists. Throws on failure. */
  async initialize(): Promise<void> {
    if (!this.config.enabled) return;
    const nlmPath = resolve(this.config.cliPath);
    if (!existsSync(nlmPath)) {
      throw new Error(`NotebookLM CLI not found at: ${nlmPath}`);
    }
    logInfo(TAG, `Initialized — CLI path: ${nlmPath}`);
  }

  /** Query a notebook. Returns cached result if within TTL. */
  async query(notebookId: string, question: string): Promise<CLIResult<RAGResult>> {
    if (!this.config.enabled) return { ok: false, error: "NotebookLM is disabled" };

    const cacheKey = this.normalizeKey(notebookId, question);
    const cached = this.cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.config.queryCacheTtlMs) {
      this.cacheHits++;
      logDebug(TAG, `Cache hit for query: "${question}" on notebook ${notebookId}`);
      return { ok: true, data: cached.result };
    }

    this.cacheMisses++;
    logDebug(TAG, `Cache miss for query: "${question}" on notebook ${notebookId}`);

    const result = await this.exec(["notebook", "query", notebookId, question, "--json"]);
    if (!result.ok) return result;

    try {
      const parsed = JSON.parse(result.data);
      const ragResult: RAGResult = {
        answer: parsed.answer ?? parsed.response ?? String(parsed),
        citations: this.parseCitations(parsed.citations ?? parsed.sources ?? []),
        confidence: this.parseConfidence(parsed),
        notebookId,
        query: question,
      };
      this.cacheSet(cacheKey, ragResult);
      logInfo(TAG, `Query OK — notebook=${notebookId} answerLen=${ragResult.answer.length} citations=${ragResult.citations.length}`);
      return { ok: true, data: ragResult };
    } catch (err) {
      const msg = `Failed to parse query response: ${err instanceof Error ? err.message : String(err)}`;
      logError(TAG, msg);
      return { ok: false, error: msg };
    }
  }

  /** List all notebooks from the CLI. */
  async listNotebooks(): Promise<CLIResult<NotebookInfo[]>> {
    if (!this.config.enabled) return { ok: false, error: "NotebookLM is disabled" };

    const result = await this.exec(["notebook", "list", "--json"]);
    if (!result.ok) return result;

    try {
      const parsed = JSON.parse(result.data);
      const notebooks: NotebookInfo[] = (Array.isArray(parsed) ? parsed : []).map((n: Record<string, unknown>) => ({
        id: String(n.id ?? n.notebook_id ?? ""),
        name: String(n.title ?? n.name ?? ""),
      }));
      return { ok: true, data: notebooks };
    } catch (err) {
      const msg = `Failed to parse notebooks response: ${err instanceof Error ? err.message : String(err)}`;
      logError(TAG, msg);
      return { ok: false, error: msg };
    }
  }

  /** Create a new notebook. */
  async createNotebook(name: string): Promise<CLIResult<string>> {
    if (!this.config.enabled) return { ok: false, error: "NotebookLM is disabled" };

    const result = await this.exec(["notebook", "create", name, "--json"]);
    if (!result.ok) return result;

    try {
      const parsed = JSON.parse(result.data);
      const id = String(parsed.notebook_id ?? parsed.id ?? "");
      if (!id) return { ok: false, error: "No notebook ID in response" };
      logInfo(TAG, `Created notebook "${name}" → ${id}`);
      return { ok: true, data: id };
    } catch (err) {
      const msg = `Failed to parse create response: ${err instanceof Error ? err.message : String(err)}`;
      logError(TAG, msg);
      return { ok: false, error: msg };
    }
  }

  /** Add a source to a notebook. */
  async addSource(notebookId: string, source: SourceDescriptor): Promise<CLIResult<SourceInfo>> {
    if (!this.config.enabled) return { ok: false, error: "NotebookLM is disabled" };

    const args = ["source", "add", notebookId];
    switch (source.type) {
      case "url": args.push("--url", source.identifier); break;
      case "pdf":
      case "markdown": args.push("--file", source.identifier); break;
      case "text": args.push("--text", source.identifier); break;
    }
    args.push("--json");

    const result = await this.exec(args);
    if (!result.ok) return result;

    try {
      const parsed = JSON.parse(result.data);
      const info: SourceInfo = {
        id: String(parsed.source_id ?? parsed.id ?? ""),
        name: String(parsed.title ?? parsed.name ?? source.identifier),
        type: source.type,
        addedAt: Date.now(),
      };
      logInfo(TAG, `Added source "${info.name}" to notebook ${notebookId}`);
      return { ok: true, data: info };
    } catch (err) {
      const msg = `Failed to parse addSource response: ${err instanceof Error ? err.message : String(err)}`;
      logError(TAG, msg);
      return { ok: false, error: msg };
    }
  }

  /** List sources in a notebook. */
  async listSources(notebookId: string): Promise<CLIResult<SourceInfo[]>> {
    if (!this.config.enabled) return { ok: false, error: "NotebookLM is disabled" };

    const result = await this.exec(["source", "list", notebookId, "--json"]);
    if (!result.ok) return result;

    try {
      const parsed = JSON.parse(result.data);
      const sources: SourceInfo[] = (Array.isArray(parsed) ? parsed : []).map((s: Record<string, unknown>) => ({
        id: String(s.id ?? s.source_id ?? ""),
        name: String(s.title ?? s.name ?? ""),
        type: String(s.type ?? s.source_type ?? "unknown"),
        addedAt: Number(s.added_at ?? s.created_at ?? 0),
      }));
      return { ok: true, data: sources };
    } catch (err) {
      const msg = `Failed to parse listSources response: ${err instanceof Error ? err.message : String(err)}`;
      logError(TAG, msg);
      return { ok: false, error: msg };
    }
  }

  /** Delete a source from a notebook. */
  async deleteSource(notebookId: string, sourceId: string): Promise<CLIResult<void>> {
    if (!this.config.enabled) return { ok: false, error: "NotebookLM is disabled" };

    const result = await this.exec(["source", "delete", notebookId, sourceId, "--json"]);
    if (!result.ok) return result;

    logInfo(TAG, `Deleted source ${sourceId} from notebook ${notebookId}`);
    return { ok: true, data: undefined };
  }

  /** Get cache statistics for observability. */
  getCacheStats(): { size: number; hits: number; misses: number } {
    return { size: this.cache.size, hits: this.cacheHits, misses: this.cacheMisses };
  }

  /** Clear cache. */
  close(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  // --- Private helpers ---

  private exec(args: string[]): Promise<CLIResult<string>> {
    const start = Date.now();
    const cmd = "nlm";
    logDebug(TAG, `Exec: ${cmd} ${args.join(" ")}`);

    return new Promise((resolve) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.config.timeoutMs);

      try {
        execFile(cmd, args, { signal: ac.signal, cwd: this.config.cliPath, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          clearTimeout(timer);
          const elapsed = Date.now() - start;
          logDebug(TAG, `Exec completed in ${elapsed}ms`);

          if (err) {
            if (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR") {
              logError(TAG, `CLI timeout after ${this.config.timeoutMs}ms: ${cmd} ${args.join(" ")}`);
              resolve({ ok: false, error: `CLI timeout after ${this.config.timeoutMs}ms` });
              return;
            }
            const errMsg = stderr?.trim() || err.message;
            logError(TAG, `CLI error: ${errMsg}`, err);
            resolve({ ok: false, error: errMsg });
            return;
          }

          resolve({ ok: true, data: stdout.trim() });
        });
      } catch (err) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        logError(TAG, `CLI exec failed: ${msg}`, err);
        resolve({ ok: false, error: msg });
      }
    });
  }

  /** Normalize cache key: lowercase, collapse whitespace. */
  normalizeKey(notebookId: string, query: string): string {
    return `${notebookId}::${query.toLowerCase().replace(/\s+/g, " ").trim()}`;
  }

  /** Insert into cache with LRU eviction at 100 entries. */
  private cacheSet(key: string, result: RAGResult): void {
    if (this.cache.size >= 100) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { result, timestamp: Date.now() });
  }

  private parseCitations(raw: unknown[]): RAGCitation[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((c) => {
      const entry = c as Record<string, unknown>;
      return {
        sourceId: String(entry.source_id ?? entry.id ?? ""),
        sourceName: String(entry.source_name ?? entry.title ?? entry.name ?? ""),
        excerpt: String(entry.excerpt ?? entry.text ?? entry.snippet ?? ""),
      };
    });
  }

  private parseConfidence(parsed: Record<string, unknown>): RAGResult["confidence"] {
    const raw = String(parsed.confidence ?? "medium").toLowerCase();
    if (raw === "high" || raw === "medium" || raw === "low" || raw === "none") return raw;
    return "medium";
  }
}
