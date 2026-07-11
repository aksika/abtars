/**
 * cli/commands/pi.ts — Pi client credential management CLI (#1313).
 *
 * Subcommands:
 *   authorize        Generate and register a new Pi client credential
 *   authorize --rotate  Replace credential and invalidate old one
 *   status           Show credential presence and metadata
 *   revoke           Revoke current credential immediately
 */

import { printBanner } from "./banner.js";
import {
  getPiClientState,
  piAuthorize,
  piRevoke,
  piRotate,
} from "../../components/pi-client-registry.js";

function formatState(): Record<string, unknown> {
  const state = getPiClientState();
  const reg = state.registration;
  return {
    authorized: state.exists && reg !== null && !reg.revokedAt,
    keyId: reg?.keyId ?? null,
    scopes: reg?.scopes ?? null,
    createdAt: reg?.createdAt ?? null,
    revokedAt: reg?.revokedAt ?? null,
  };
}

export async function pi(args: string[]): Promise<number> {
  await printBanner("pi");
  const sub = args[0] ?? "status";

  switch (sub) {
    case "authorize": {
      const rotate = args.includes("--rotate");
      try {
        if (rotate) {
          const cred = piRotate();
          process.stdout.write(JSON.stringify({ ok: true, keyId: cred.keyId, rotated: true }) + "\n");
        } else {
          const cred = piAuthorize();
          process.stdout.write(JSON.stringify({ ok: true, keyId: cred.keyId }) + "\n");
        }
        return 0;
      } catch (err) {
        process.stderr.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
        return 1;
      }
    }

    case "revoke": {
      try {
        piRevoke();
        process.stdout.write(JSON.stringify({ ok: true, revoked: true }) + "\n");
        return 0;
      } catch (err) {
        process.stderr.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
        return 1;
      }
    }

    case "status":
    default: {
      process.stdout.write(JSON.stringify(formatState(), null, 2) + "\n");
      return 0;
    }
  }
}
