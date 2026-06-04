import { MEMORY_CONFIG_DEFAULTS } from "abmind";
import type { MemoryConfig } from "abmind";

export function makeMemoryTestConfig(tmpDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir, ...overrides };
}
