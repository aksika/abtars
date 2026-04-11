import { MEMORY_CONFIG_DEFAULTS } from "@agentbridge/memory/memory-config.js";
import type { MemoryConfig } from "@agentbridge/memory/memory-config.js";

export function makeMemoryTestConfig(tmpDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir, ...overrides };
}
