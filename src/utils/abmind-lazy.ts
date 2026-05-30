/**
 * Lazy abmind loader — pre-loaded once at boot, then available synchronously.
 * ALL runtime access to abmind goes through here.
 * If abmind is not installed, abmind() returns null.
 */

type AbmindModule = typeof import("abmind");

let _mod: AbmindModule | null = null;
let _loaded = false;

/** Call once at boot (phase-memory). Caches the module. */
export async function loadAbmind(): Promise<AbmindModule | null> {
  if (_loaded) return _mod;
  try {
    _mod = await import("abmind");
  } catch {
    _mod = null;
  }
  _loaded = true;
  return _mod;
}

/** Synchronous access after loadAbmind() has been called. Returns null if unavailable. */
export function abmind(): AbmindModule | null {
  return _mod;
}
