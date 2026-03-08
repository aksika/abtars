import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { logWarn, logDebug } from "./logger.js";
import type { NotebookRegistryData, NotebookRegistryEntry } from "../types/index.js";

const TAG = "NotebookRegistry";
const DEFAULT_DIR = resolve(homedir(), ".agentbridge", "notebooklm");
const REGISTRY_FILE = "registry.json";

const EMPTY_REGISTRY: NotebookRegistryData = { version: 1, notebooks: [] };

export class NotebookRegistry {
  private readonly filePath: string;

  constructor(registryDir?: string) {
    const dir = registryDir ?? DEFAULT_DIR;
    this.filePath = resolve(dir, REGISTRY_FILE);
    this.ensureDir(dir);
  }

  /** Load registry from disk. Creates empty registry if missing or corrupt. */
  load(): NotebookRegistryData {
    if (!existsSync(this.filePath)) {
      this.save(EMPTY_REGISTRY);
      return { ...EMPTY_REGISTRY, notebooks: [] };
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as NotebookRegistryData;
      if (!data.notebooks || !Array.isArray(data.notebooks)) {
        throw new Error("invalid registry structure");
      }
      return data;
    } catch (err) {
      logWarn(TAG, `Registry corrupt or unreadable, creating fresh: ${err instanceof Error ? err.message : String(err)}`);
      const fresh = { ...EMPTY_REGISTRY, notebooks: [] };
      this.save(fresh);
      return fresh;
    }
  }

  /** Save registry to disk. */
  save(data: NotebookRegistryData): void {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** Resolve a notebook name to its ID. Returns null if not found. */
  resolve(name: string): string | null {
    const data = this.load();
    const entry = data.notebooks.find((n) => n.name === name);
    return entry?.notebookId ?? null;
  }

  /** Register a new notebook entry. */
  register(entry: NotebookRegistryEntry): void {
    const data = this.load();
    const existing = data.notebooks.findIndex((n) => n.name === entry.name);
    if (existing >= 0) {
      data.notebooks[existing] = entry;
    } else {
      data.notebooks.push(entry);
    }
    this.save(data);
    logDebug(TAG, `Registered notebook "${entry.name}" → ${entry.notebookId}`);
  }

  /** List all registered notebooks. */
  list(): NotebookRegistryEntry[] {
    return this.load().notebooks;
  }

  /** Get available notebook names (for error messages). */
  availableNames(): string[] {
    return this.load().notebooks.map((n) => n.name);
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
