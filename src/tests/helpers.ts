import { MEMORY_CONFIG_DEFAULTS } from "abmind/memory-config.js";
import type { MemoryConfig } from "abmind/memory-config.js";

export function makeMemoryTestConfig(tmpDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir, ...overrides };
}
