import "abmind";

/**
 * abtars uses `memory.available` as a runtime availability flag — set to
 * false when a memory bundle comes back empty, so later prompt/soul builds
 * skip memory rather than emitting a broken bundle. abmind's MemoryManager
 * class does not declare this field, so we augment it here. This is
 * abtars-managed runtime state, NOT part of abmind's public contract.
 */
declare module "abmind" {
  interface MemoryManager {
    available?: boolean;
  }
}
