#!/usr/bin/env node
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  readSupervisorState,
  setDesiredState,
  publishCommand,
  claimPendingCommand,
  ackCommand,
  recordBridgeDeath,
  recordHealthyInterval,
  resetRestartCount,
  migrateSupervisorState,
  getBackoffDelayMs,
} from "./state.js";

const home = process.env.ABTARS_HOME ?? resolve(homedir(), ".abtars");

enum Exit {
  Ok = 0,
  Usage = 1,
  Error = 2,
}

function main(): void {
  const cmd = process.argv[2];

  switch (cmd) {
    case "read": {
      const result = readSupervisorState(home);
      if (result.ok) {
        process.stdout.write(JSON.stringify(result.state) + "\n");
        process.exit(Exit.Ok);
      }
      process.stderr.write(result.reason + "\n");
      process.exit(Exit.Error);
    }

    case "set-desired-state": {
      const desired = process.argv[3];
      if (desired !== "running" && desired !== "stopped") {
        process.stderr.write("Usage: supervisor-state set-desired-state <running|stopped>\n");
        process.exit(Exit.Usage);
      }
      const state = setDesiredState(home, desired);
      process.stdout.write(JSON.stringify(state) + "\n");
      process.exit(Exit.Ok);
    }

    case "publish-command": {
      const type = process.argv[3];
      const reason = process.argv[4];
      if (!type || !reason) {
        process.stderr.write("Usage: supervisor-state publish-command <type> <reason>\n");
        process.exit(Exit.Usage);
      }
      const { result, state } = publishCommand(home, type, reason);
      process.stdout.write(JSON.stringify({ result, seq: state.pendingCommand?.seq ?? null }) + "\n");
      process.exit(Exit.Ok);
    }

    case "claim-command": {
      const cmd = claimPendingCommand(home);
      if (cmd) {
        process.stdout.write(JSON.stringify(cmd) + "\n");
      } else {
        process.stdout.write("null\n");
      }
      process.exit(Exit.Ok);
    }

    case "ack-command": {
      const seqStr = process.argv[3];
      if (seqStr === undefined) {
        process.stderr.write("Usage: supervisor-state ack-command <seq>\n");
        process.exit(Exit.Usage);
      }
      const seq = parseInt(seqStr, 10);
      if (isNaN(seq)) {
        process.stderr.write("Usage: supervisor-state ack-command <seq>\n");
        process.exit(Exit.Usage);
      }
      const ok = ackCommand(home, seq);
      process.stdout.write(ok ? "ok\n" : "mismatch\n");
      process.exit(Exit.Ok);
    }

    case "record-death": {
      const reason = process.argv[3] ?? "unknown";
      recordBridgeDeath(home, { at: Date.now(), reason });
      process.stdout.write("ok\n");
      process.exit(Exit.Ok);
    }

    case "record-healthy": {
      recordHealthyInterval(home, Date.now());
      process.stdout.write("ok\n");
      process.exit(Exit.Ok);
    }

    case "reset-restart-count": {
      const reason = process.argv[3] ?? "manual";
      resetRestartCount(home, reason);
      process.stdout.write("ok\n");
      process.exit(Exit.Ok);
    }

    case "get-backoff": {
      const read = readSupervisorState(home);
      const delay = read.ok ? getBackoffDelayMs(read.state) : 0;
      process.stdout.write(String(delay) + "\n");
      process.exit(Exit.Ok);
    }

    case "migrate": {
      const result = migrateSupervisorState(home);
      if (result.ok) {
        process.stdout.write(result.migrated ? "migrated\n" : "noop\n");
        process.exit(Exit.Ok);
      }
      process.stderr.write(result.error + "\n");
      process.exit(Exit.Error);
    }

    case "desired-state": {
      const read = readSupervisorState(home);
      if (read.ok) {
        process.stdout.write(read.state.desiredState + "\n");
        process.exit(Exit.Ok);
      }
      process.stderr.write("unavailable\n");
      process.exit(Exit.Error);
    }

    case "is-stopped": {
      const read = readSupervisorState(home);
      if (read.ok && read.state.desiredState === "stopped") {
        process.stdout.write("yes\n");
        process.exit(Exit.Ok);
      }
      process.stdout.write("no\n");
      process.exit(Exit.Ok);
    }

    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      process.stderr.write("Available: read, desired-state, is-stopped, set-desired-state, publish-command, claim-command, ack-command, record-death, record-healthy, reset-restart-count, get-backoff, migrate\n");
      process.exit(Exit.Usage);
  }
}

main();
