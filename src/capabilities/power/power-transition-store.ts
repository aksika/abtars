import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { abtarsHome } from "../../paths.js";
import type { PowerTransitionState } from "./types.js";

export class PowerTransitionStore {
  constructor(
    private readonly filePath: string = join(abtarsHome(), "state", "power-transition.json"),
  ) {}

  read(): PowerTransitionState | null {
    try {
      if (!existsSync(this.filePath)) return null;
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as PowerTransitionState;
      if (raw.expiresAt && raw.expiresAt < Date.now()) {
        this.clear();
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  write(state: PowerTransitionState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(state), "utf-8");
    } catch {
      // best-effort; transition is advisory
    }
  }

  clear(): void {
    try {
      if (existsSync(this.filePath)) {
        writeFileSync(this.filePath, JSON.stringify(null), "utf-8");
      }
    } catch {
      // best-effort
    }
  }

  isActive(): boolean {
    return this.read() !== null;
  }

  /**
   * #1517: active-transition check that ignores only the exact attempt ID
   * passed in. A marker with no ID, a different ID, or any readable legacy
   * state is never excluded.
   */
  isActiveExcept(attemptId?: string): boolean {
    const state = this.read();
    if (!state) return false;
    if (attemptId !== undefined && state.attemptId === attemptId) return false;
    return true;
  }

  /** #1517: clear the marker only when this attempt still owns it. */
  clearIfOwned(attemptId: string): boolean {
    const state = this.read();
    if (!state || state.attemptId !== attemptId) return false;
    this.clear();
    return true;
  }
}
