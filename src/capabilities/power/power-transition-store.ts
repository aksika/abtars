import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PowerTransitionState } from "./types.js";

const TRANSITION_FILE = join(homedir(), ".abtars", "state", "power-transition.json");

export class PowerTransitionStore {
  read(): PowerTransitionState | null {
    try {
      if (!existsSync(TRANSITION_FILE)) return null;
      const raw = JSON.parse(readFileSync(TRANSITION_FILE, "utf-8")) as PowerTransitionState;
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
      mkdirSync(join(homedir(), ".abtars", "state"), { recursive: true });
      writeFileSync(TRANSITION_FILE, JSON.stringify(state), "utf-8");
    } catch {
      // best-effort; transition is advisory
    }
  }

  clear(): void {
    try {
      if (existsSync(TRANSITION_FILE)) {
        writeFileSync(TRANSITION_FILE, JSON.stringify(null), "utf-8");
      }
    } catch {
      // best-effort
    }
  }

  isActive(): boolean {
    return this.read() !== null;
  }
}
