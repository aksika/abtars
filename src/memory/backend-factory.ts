/**
 * Backend factory — creates the configured MemoryBackend.
 * CLI tools call this instead of new MemoryManager().
 */

import type { MemoryBackend } from "./memory-backend.js";
import type { MemoryConfig } from "./memory-config.js";
import { SqliteBackend } from "./sqlite-backend.js";

/** Create and initialize a MemoryBackend based on MEMORY_BACKEND env var. */
export async function createMemoryBackend(config: MemoryConfig): Promise<MemoryBackend> {
  const backendType = process.env["MEMORY_BACKEND"] ?? "sqlite";

  switch (backendType) {
    case "sqlite":
      break;
    default:
      throw new Error(`Unknown MEMORY_BACKEND: ${backendType}. Supported: sqlite`);
  }

  const backend = new SqliteBackend(config);
  await backend.initialize();
  return backend;
}
