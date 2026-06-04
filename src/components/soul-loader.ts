/**
 * soul-loader.ts — Thin wrapper around soul-bundle for backward compatibility.
 * All logic lives in soul-bundle.ts now.
 */
import { buildSoulBundle } from "./soul-bundle.js";
import type { MemoryManager } from "abmind";

export function loadSoulBundle(memory?: MemoryManager | null): string | null {
  return buildSoulBundle("A", memory);
}

export function loadMinimalSoul(memory?: MemoryManager | null): string | null {
  return buildSoulBundle("C", memory);
}
