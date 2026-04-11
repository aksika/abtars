#!/usr/bin/env node
/**
 * abmind — Unified CLI for AgentBridge Memory.
 *
 * Usage:
 *   abmind recall --translated "kw1,kw2" --chat-id <id>
 *   abmind store --translated "English" --memory-type fact --chat-id <id>
 *   abmind edit --memory-id 42 --boost
 *   abmind expand --ids 451,452,453
 *   abmind embed
 *   abmind retro-extract [--dry-run]
 *   abmind backfill [--dry-run]
 *   abmind status
 *   abmind wake-up [--ctx-window 128000]
 */

const subcommand = process.argv[2];

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  console.log(`abmind — AgentBridge Memory CLI

Subcommands:
  recall          Search memories
  store           Store a new memory
  edit            Edit an existing memory
  expand          Look up source messages by ID
  embed           Batch embed all memories
  retro-extract   Extract facts from retrospective files
  backfill        One-time migration: fill ABM v2 columns
  status          Show memory system stats
  wake-up         Print current wake-up context

Run 'abmind <subcommand> --help' for details.`);
  process.exit(0);
}

// Shift argv so subcommand handlers see their args at argv[2+]
process.argv.splice(2, 1);

switch (subcommand) {
  case "recall":
    await import("./abmind-recall.js");
    break;
  case "store":
    await import("./abmind-store.js");
    break;
  case "edit":
    await import("./abmind-edit.js");
    break;
  case "expand":
    await import("./abmind-expand.js");
    break;
  case "embed":
    await import("./abmind-embed.js");
    break;
  case "retro-extract":
    await import("./abmind-retro-extract.js");
    break;
  case "backfill":
    await import("./abmind-backfill.js");
    break;
  case "status":
    await import("./abmind-status.js");
    break;
  case "wake-up":
  case "wakeup":
    await import("./abmind-wakeup.js");
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand}\nRun 'abmind --help' for usage.`);
    process.exit(1);
}
