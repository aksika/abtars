/**
 * Transport controller — handles runtime switching between tmux and ACP
 * transport modes and reports current transport status.
 */

import type { Config } from "../types/index.js";
import type { IKiroTransport } from "./kiro-transport.js";
import type { PlatformRefs } from "./platform-controller.js";
import type { TransportStatus } from "./dashboard-config.js";
import { TmuxClient } from "./tmux-client.js";
import { AcpTransport } from "./acp-transport.js";
import { logInfo, logError } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Minimal memory interface needed by the transport controller. */
export type TransportMemoryRef = {
  setLlmCall(llmCall: (prompt: string, content: string) => Promise<string>): void;
};

export type TransportSwitchDeps = {
  config: Config;
  getCurrentTransport: () => IKiroTransport;
  setTransport: (t: IKiroTransport) => void;
  platformRefs: PlatformRefs;
  memory: TransportMemoryRef | null;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const TAG = "transport-ctrl";

/** Determine the mode label for a transport instance. */
function transportMode(t: IKiroTransport): "tmux" | "acp" {
  return t instanceof TmuxClient ? "tmux" : "acp";
}

/** Create a new transport from config for the requested mode. */
function createTransport(config: Config, mode: "tmux" | "acp"): IKiroTransport {
  if (mode === "tmux") {
    return new TmuxClient(
      config.tmuxSession,
      config.tmuxCaptureDelaySec,
      config.tmuxMaxWaitSec,
    );
  }
  return new AcpTransport(config.kiroCLIPath, config.workingDir);
}

// ── Controller ──────────────────────────────────────────────────────────────

export class TransportController {
  private readonly deps: TransportSwitchDeps;

  constructor(deps: TransportSwitchDeps) {
    this.deps = deps;
  }

  /**
   * Handle `POST /api/transport/switch { mode: "tmux" | "acp" }`.
   *
   * Switch sequence:
   *  1. No-op if requested mode === current mode (200)
   *  2. Stop all running platform pollers
   *  3. Destroy current transport
   *  4. Create + initialize new transport
   *  5. Re-register memory LLM callback if memory enabled
   *  6. Update shared transport reference
   *  7. Restart previously-running pollers
   *  8. On failure: rollback to previous transport, return 500
   */
  async handle(mode: "tmux" | "acp"): Promise<{ status: number; body: object }> {
    const current = this.deps.getCurrentTransport();
    const currentMode = transportMode(current);

    // 1. No-op
    if (mode === currentMode) {
      return {
        status: 200,
        body: { message: `Already running ${mode} transport`, switched: false },
      };
    }

    // Snapshot which pollers were running so we can restart them later
    const { platformRefs } = this.deps;
    const telegramWasRunning = platformRefs.telegramPoller !== null && await this.isPollerRunning(platformRefs.telegramPoller);
    const discordWasRunning = platformRefs.discordPoller !== null && await this.isPollerRunning(platformRefs.discordPoller);

    try {
      // 2. Stop all running pollers
      if (telegramWasRunning) platformRefs.telegramPoller!.stop();
      if (discordWasRunning) platformRefs.discordPoller!.stop();

      // 3. Destroy current transport
      current.destroy();

      // 4. Create and initialize new transport
      const newTransport = createTransport(this.deps.config, mode);
      await newTransport.initialize();

      // 5. Re-register memory LLM callback
      if (this.deps.memory) {
        this.deps.memory.setLlmCall(async (prompt: string, content: string) => {
          return newTransport.sendPrompt("system:memory", `${prompt}\n\n${content}`);
        });
      }

      // 6. Update shared reference
      this.deps.setTransport(newTransport);

      logInfo(TAG, `Switched transport: ${currentMode} → ${mode}`);

      // 7. Restart previously-running pollers
      if (telegramWasRunning && platformRefs.telegramPoller) {
        await platformRefs.telegramPoller.start();
      }
      if (discordWasRunning && platformRefs.discordPoller) {
        await platformRefs.discordPoller.start();
      }

      return {
        status: 200,
        body: {
          message: `Switched to ${mode} transport`,
          switched: true,
          transport: this.getTransportStatus(),
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError(TAG, `Transport switch to ${mode} failed: ${errMsg}`);

      // 8. Rollback — try to re-initialize the previous transport
      try {
        const rollback = createTransport(this.deps.config, currentMode);
        await rollback.initialize();

        if (this.deps.memory) {
          this.deps.memory.setLlmCall(async (prompt: string, content: string) => {
            return rollback.sendPrompt("system:memory", `${prompt}\n\n${content}`);
          });
        }

        this.deps.setTransport(rollback);
        logInfo(TAG, `Rolled back to ${currentMode} transport`);

        // Restart pollers after rollback
        if (telegramWasRunning && platformRefs.telegramPoller) {
          await platformRefs.telegramPoller.start();
        }
        if (discordWasRunning && platformRefs.discordPoller) {
          await platformRefs.discordPoller.start();
        }
      } catch (rollbackErr) {
        logError(TAG, `Rollback to ${currentMode} also failed`, rollbackErr);
      }

      return {
        status: 500,
        body: { error: `Transport switch failed: ${errMsg}` },
      };
    }
  }

  /** Current transport info for the status snapshot. */
  getTransportStatus(): TransportStatus {
    const transport = this.deps.getCurrentTransport();
    const mode = transportMode(transport);
    let contextPercent = -1;

    if ("contextPercent" in transport) {
      const pct = (transport as TmuxClient).contextPercent;
      if (typeof pct === "number") contextPercent = pct;
    }

    return {
      type: mode,
      ready: transport.isReady,
      contextPercent,
    };
  }

  /**
   * Best-effort check whether a poller is currently running.
   * Pollers expose `running` (Telegram) or `started` (Discord) but these
   * are private — we duck-type check for them.
   */
  private isPollerRunning(poller: unknown): boolean {
    if (poller && typeof poller === "object") {
      if ("running" in poller && typeof (poller as Record<string, unknown>).running === "boolean") {
        return (poller as Record<string, boolean>).running ?? false;
      }
      if ("started" in poller && typeof (poller as Record<string, unknown>).started === "boolean") {
        return (poller as Record<string, boolean>).started ?? false;
      }
    }
    return false;
  }
}
