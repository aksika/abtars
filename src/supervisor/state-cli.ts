#!/usr/bin/env node
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
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
import { validateBridgeLock } from "./identity.js";
import { atomicWriteSync } from "../components/atomic-write.js";

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
      // Shell-friendly: "<seq> <type>" or "0 none" when no command is pending.
      // The watchdog acks only AFTER applying the action (see abtars-watchdog.sh).
      const cmd = claimPendingCommand(home);
      if (cmd) {
        process.stdout.write(`${cmd.seq} ${cmd.type}\n`);
      } else {
        process.stdout.write("0 none\n");
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

    case "validate-bridge": {
      // Validate the bridge recorded in bridge.lock via the shared identity
      // validator (R6). Shell-friendly output: "<status> <pid> <startedAtMs>".
      const lockPath = join(home, "bridge.lock");
      let lock: Record<string, unknown> | null = null;
      try { lock = JSON.parse(readFileSync(lockPath, "utf-8")); } catch { /* missing */ }
      const result = validateBridgeLock(lock, ["abtars.js", "bundle"]);
      const lo = lock as { pid?: unknown; startedAt?: unknown } | null;
      const pid = lo && typeof lo.pid === "number" ? lo.pid : 0;
      const startedAt = lo && typeof lo.startedAt === "number" ? lo.startedAt : 0;
      process.stdout.write(`${result.status} ${pid} ${startedAt}\n`);
      process.exit(Exit.Ok);
    }

    case "set-watchdog-pid": {
      // Atomic read-merge-write of the watchdog-owned watchdogPid field in
      // bridge.lock (R1.3). Replaces the watchdog's former inline python3
      // mutation (R2.2 — shell must not mutate JSON directly).
      const pidStr = process.argv[3];
      if (pidStr === undefined) {
        process.stderr.write("Usage: supervisor-state set-watchdog-pid <pid>\n");
        process.exit(Exit.Usage);
      }
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) {
        process.stderr.write("Usage: supervisor-state set-watchdog-pid <pid>\n");
        process.exit(Exit.Usage);
      }
      setBridgeWatchdogPid(home, pid);
      process.stdout.write("ok\n");
      process.exit(Exit.Ok);
    }

    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      process.stderr.write("Available: read, desired-state, is-stopped, set-desired-state, publish-command, claim-command, ack-command, record-death, record-healthy, reset-restart-count, get-backoff, migrate, validate-bridge, set-watchdog-pid\n");
      process.exit(Exit.Usage);
  }
}

function setBridgeWatchdogPid(home: string, pid: number): void {
  const p = join(home, "bridge.lock");
  let lock: Record<string, unknown> = {};
  try { lock = JSON.parse(readFileSync(p, "utf-8")); } catch { /* missing — seed */ }
  lock["watchdogPid"] = pid;
  atomicWriteSync(p, JSON.stringify(lock));
}

main();
