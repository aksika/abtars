/**
 * Platform controller — routes start/stop API requests to the appropriate
 * platform poller and reports current running states.
 */

import type { TelegramPoller } from "./telegram-poller.js";
import type { DiscordPoller } from "./discord-poller.js";
import type { PlatformStates } from "./dashboard-config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type PlatformRefs = {
  telegramPoller: TelegramPoller | null;
  discordPoller: DiscordPoller | null;
};

// ── Controller ──────────────────────────────────────────────────────────────

const VALID_PLATFORMS = new Set(["telegram", "discord"]);
const VALID_ACTIONS = new Set(["start", "stop"]);

export class PlatformController {
  private readonly refs: PlatformRefs;

  /**
   * Track running state internally since poller `running`/`started`
   * properties are private.  State is updated on successful start/stop.
   */
  private readonly state: Record<string, boolean> = {
    telegram: false,
    discord: false,
  };

  constructor(refs: PlatformRefs) {
    this.refs = refs;
  }

  /**
   * Handle `POST /api/platforms/:platform/:action`.
   *
   * Returns:
   *  - 400 for invalid platform or action
   *  - 409 if the poller is null (not configured at startup)
   *  - 500 if the poller method throws
   *  - 200 with updated state on success
   */
  async handle(
    platform: string,
    action: string,
  ): Promise<{ status: number; body: object }> {
    if (!VALID_PLATFORMS.has(platform) || !VALID_ACTIONS.has(action)) {
      return {
        status: 400,
        body: { error: `Invalid platform "${platform}" or action "${action}"` },
      };
    }

    const poller = platform === "telegram"
      ? this.refs.telegramPoller
      : this.refs.discordPoller;

    if (poller === null) {
      return {
        status: 409,
        body: { error: `${platform} is not configured` },
      };
    }

    try {
      if (action === "start") {
        await poller.start();
        this.state[platform] = true;
      } else {
        poller.stop();
        this.state[platform] = false;
      }

      return {
        status: 200,
        body: { platform, running: this.state[platform] },
      };
    } catch (err) {
      return {
        status: 500,
        body: {
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** Current running state of each platform for the status snapshot. */
  getStates(): PlatformStates {
    return {
      telegram: {
        configured: this.refs.telegramPoller !== null,
        running: this.state.telegram ?? false,
      },
      discord: {
        configured: this.refs.discordPoller !== null,
        running: this.state.discord ?? false,
      },
    };
  }
}
