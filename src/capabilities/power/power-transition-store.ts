import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
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
        // #1517: expiry cleanup must not erase a replacement marker written
        // after this snapshot was read by another process.
        this.clearIfUnchanged(raw);
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

  /** Remove an expired marker only if the same marker still owns the path. */
  private clearIfUnchanged(expected: PowerTransitionState): boolean {
    try {
      if (!existsSync(this.filePath)) return false;
      const held = this.filePath + ".expired-check";
      renameSync(this.filePath, held);
      let unchanged = false;
      try {
        const state = JSON.parse(readFileSync(held, "utf-8")) as PowerTransitionState;
        unchanged = JSON.stringify(state) === JSON.stringify(expected);
      } catch {
        unchanged = false;
      }
      if (unchanged) {
        rmSync(held, { force: true });
        return true;
      }
      if (existsSync(this.filePath)) {
        rmSync(held, { force: true });
      } else {
        renameSync(held, this.filePath);
      }
      return false;
    } catch {
      return false;
    }
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

  /**
   * #1517: clear the marker only when this attempt still owns it. The current
   * file is moved aside with a single atomic rename before its ownership is
   * verified, so a replacement marker written concurrently lands at the
   * original path and is never erased; only the moved copy is deleted when it
   * is the owned marker, and a foreign or unreadable copy is restored (unless
   * a replacement already took its place).
   */
  clearIfOwned(attemptId: string): boolean {
    try {
      if (!existsSync(this.filePath)) return false;
      const held = this.filePath + ".owned-check";
      renameSync(this.filePath, held);
      let owned = false;
      try {
        const state = JSON.parse(readFileSync(held, "utf-8")) as PowerTransitionState | null;
        owned = Boolean(state && state.attemptId === attemptId);
      } catch {
        owned = false;
      }
      if (owned) {
        rmSync(held, { force: true });
        return true;
      }
      if (existsSync(this.filePath)) {
        // A concurrent attempt already wrote its replacement marker; keep it.
        rmSync(held, { force: true });
      } else {
        renameSync(held, this.filePath);
      }
      return false;
    } catch {
      return false;
    }
  }
}
