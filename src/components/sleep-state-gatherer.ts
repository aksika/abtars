import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { logInfo, logWarn, logError } from "./logger.js";

const TAG = "sleep-state-gatherer";

export interface WorkingDirEntry {
  date: string; // YYYY-MM-DD
  path: string; // full path
  files: Array<{
    name: string;
    sizeBytes: number;
  }>;
}

export interface DbStats {
  messageCount: number;
  compactionCount: number;
  embeddingCount: number;
  sessionCount: number;
  extractedMemoryCount: number;
}

export interface Fts5Health {
  messages_fts: "ok" | "corrupt";
  extracted_memories_fts: "ok" | "corrupt";
  extracted_memories_original_fts: "ok" | "corrupt";
}

export interface TopicFileEntry {
  name: string;
  sizeBytes: number;
  lastModified: string; // ISO 8601
}

export interface StateSnapshot {
  timestamp: string; // ISO 8601
  workingDirs: WorkingDirEntry[];
  dbStats: DbStats;
  fts5Health: Fts5Health;
  diskUsageBytes: number;
  diskBudgetBytes: number;
  topicFiles: TopicFileEntry[];
}

export class SleepStateGatherer {
  constructor(
    private db: Database.Database,
    private config: MemoryConfig,
  ) {}

  async gather(): Promise<StateSnapshot> {
    const timestamp = new Date().toISOString();
    logInfo(TAG, "Gathering system state snapshot");

    const workingDirs = this.scanWorkingDirs();
    const dbStats = this.queryDbStats();
    const fts5Health = this.checkFts5Health();
    const diskUsageBytes = this.calculateDiskUsage();
    const topicFiles = this.listTopicFiles();

    const snapshot: StateSnapshot = {
      timestamp,
      workingDirs,
      dbStats,
      fts5Health,
      diskUsageBytes,
      diskBudgetBytes: this.config.diskBudgetBytes,
      topicFiles,
    };

    logInfo(
      TAG,
      `State snapshot gathered: ${workingDirs.length} working dirs, ` +
        `${dbStats.messageCount} messages, ${topicFiles.length} topic files, ` +
        `${(diskUsageBytes / 1024 / 1024).toFixed(1)} MB disk usage`,
    );

    return snapshot;
  }

  /** Scan working directories under {memoryDir}/working/ */
  private scanWorkingDirs(): WorkingDirEntry[] {
    const workingRoot = join(this.config.memoryDir, "working");
    if (!existsSync(workingRoot)) {
      logWarn(TAG, `Working directory not found: ${workingRoot}`);
      return [];
    }

    const entries: WorkingDirEntry[] = [];
    try {
      const dirs = readdirSync(workingRoot, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        // Expect YYYY-MM-DD format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dir.name)) continue;

        const dirPath = join(workingRoot, dir.name);
        const files: WorkingDirEntry["files"] = [];
        try {
          const fileEntries = readdirSync(dirPath, { withFileTypes: true });
          for (const file of fileEntries) {
            if (!file.isFile()) continue;
            try {
              const fileStat = statSync(join(dirPath, file.name));
              files.push({ name: file.name, sizeBytes: fileStat.size });
            } catch (err) {
              logWarn(TAG, `Failed to stat file ${join(dirPath, file.name)}: ${err}`);
            }
          }
        } catch (err) {
          logWarn(TAG, `Failed to read working directory ${dirPath}: ${err}`);
        }

        entries.push({ date: dir.name, path: dirPath, files });
      }
    } catch (err) {
      logWarn(TAG, `Failed to scan working root ${workingRoot}: ${err}`);
    }

    return entries.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Query DB for aggregate statistics. */
  private queryDbStats(): DbStats {
    const count = (table: string): number => {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
        return row.cnt;
      } catch (err) {
        logError(TAG, `Failed to count rows in ${table}`, err);
        throw err;
      }
    };

    return {
      messageCount: count("messages"),
      compactionCount: count("compactions"),
      embeddingCount: count("embeddings"),
      sessionCount: count("sessions"),
      extractedMemoryCount: count("extracted_memories"),
    };
  }

  /** Execute FTS5 integrity-check on each virtual table. */
  private checkFts5Health(): Fts5Health {
    const check = (table: string): "ok" | "corrupt" => {
      try {
        // FTS5 integrity-check: throws if the index is corrupt
        this.db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
        return "ok";
      } catch (err) {
        logWarn(TAG, `FTS5 integrity-check failed for ${table}: ${err}`);
        return "corrupt";
      }
    };

    return {
      messages_fts: check("messages_fts"),
      extracted_memories_fts: check("extracted_memories_fts"),
      extracted_memories_original_fts: check("extracted_memories_original_fts"),
    };
  }

  /** Calculate total disk usage across the memory directory tree. */
  private calculateDiskUsage(): number {
    let totalBytes = 0;

    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            try {
              totalBytes += statSync(fullPath).size;
            } catch {
              // skip unreadable files
            }
          }
        }
      } catch {
        // skip unreadable directories
      }
    };

    walk(this.config.memoryDir);
    return totalBytes;
  }

  /** List topic files in {agentbridgeHome}/topics/ with metadata. */
  private listTopicFiles(): TopicFileEntry[] {
    // Topics dir is at the agentbridge root level, one level up from memoryDir
    // memoryDir = ~/.agentbridge/memory → topics = ~/.agentbridge/topics
    const topicsDir = join(dirname(this.config.memoryDir), "topics");
    if (!existsSync(topicsDir)) {
      logWarn(TAG, `Topics directory not found: ${topicsDir}`);
      return [];
    }

    const entries: TopicFileEntry[] = [];
    try {
      const files = readdirSync(topicsDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".md")) continue;
        try {
          const fileStat = statSync(join(topicsDir, file.name));
          entries.push({
            name: file.name,
            sizeBytes: fileStat.size,
            lastModified: fileStat.mtime.toISOString(),
          });
        } catch (err) {
          logWarn(TAG, `Failed to stat topic file ${file.name}: ${err}`);
        }
      }
    } catch (err) {
      logWarn(TAG, `Failed to read topics directory ${topicsDir}: ${err}`);
    }

    return entries;
  }
}
