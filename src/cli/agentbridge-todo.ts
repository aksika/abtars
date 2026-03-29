#!/usr/bin/env node
/**
 * agentbridge-todo — persistent todo list CLI.
 *
 * Usage:
 *   agentbridge-todo add "Export X/Twitter session cookies"
 *   agentbridge-todo list
 *   agentbridge-todo done 3
 *   agentbridge-todo remove 3
 *
 * File: ~/.agentbridge/memory/todo.md
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { localDate } from "../components/env-utils.js";

const todoPath = (): string => join(homedir(), ".agentbridge", "memory", "todo.md");
const HEADER = "# Todo List\n";

function ensureFile(): void {
  const p = todoPath();
  const dir = join(homedir(), ".agentbridge", "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(p)) writeFileSync(p, HEADER, "utf-8");
}

function readLines(): string[] {
  ensureFile();
  return readFileSync(todoPath(), "utf-8").split("\n");
}

function writeLines(lines: string[]): void {
  writeFileSync(todoPath(), lines.join("\n"), "utf-8");
}

/** Find indices of todo item lines (- [ ] or - [x]) */
function itemIndices(lines: string[]): number[] {
  return lines.reduce<number[]>((acc, line, i) => {
    if (/^- \[[ x]\] /.test(line)) acc.push(i);
    return acc;
  }, []);
}

function add(description: string): void {
  ensureFile();
  const date = localDate();
  const entry = `- [ ] ${date}: ${description}\n`;
  const content = readFileSync(todoPath(), "utf-8");
  writeFileSync(todoPath(), content.endsWith("\n") ? content + entry : content + "\n" + entry, "utf-8");
  console.log(JSON.stringify({ ok: true, action: "added", description }));
}

function list(): void {
  const lines = readLines();
  const items = lines.filter(l => /^- \[[ x]\] /.test(l));
  if (items.length === 0) {
    console.log(JSON.stringify({ ok: true, items: [], message: "Todo list is empty" }));
    return;
  }
  // Print raw for agent readability
  console.log(items.join("\n"));
}

function done(lineNum: number): void {
  const lines = readLines();
  const indices = itemIndices(lines);
  if (lineNum < 1 || lineNum > indices.length) {
    console.log(JSON.stringify({ ok: false, error: `Invalid item number ${lineNum}. Have ${indices.length} items.` }));
    process.exit(1);
  }
  const idx = indices[lineNum - 1]!;
  lines[idx] = lines[idx]!.replace("- [ ]", "- [x]");
  writeLines(lines);
  console.log(JSON.stringify({ ok: true, action: "done", item: lineNum }));
}

function remove(lineNum: number): void {
  const lines = readLines();
  const indices = itemIndices(lines);
  if (lineNum < 1 || lineNum > indices.length) {
    console.log(JSON.stringify({ ok: false, error: `Invalid item number ${lineNum}. Have ${indices.length} items.` }));
    process.exit(1);
  }
  const idx = indices[lineNum - 1]!;
  lines.splice(idx, 1);
  writeLines(lines);
  console.log(JSON.stringify({ ok: true, action: "removed", item: lineNum }));
}

// --- CLI entry point ---

export function main(argv: string[] = process.argv): void {
  const args = argv.slice(2);

  if (args.includes('--help')) {
    console.log(`Usage:
  agentbridge-todo add "description"
  agentbridge-todo list
  agentbridge-todo done <number>
  agentbridge-todo remove <number>

File: ~/.agentbridge/memory/todo.md`);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "add": {
      const desc = args[1];
      if (!desc) { console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-todo add \"description\"" })); process.exit(1); }
      add(desc);
      break;
    }
    case "list":
      list();
      break;
    case "done": {
      const n = parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(n)) { console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-todo done <number>" })); process.exit(1); }
      done(n);
      break;
    }
    case "remove": {
      const n = parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(n)) { console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-todo remove <number>" })); process.exit(1); }
      remove(n);
      break;
    }
    default:
      console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-todo <add|list|done|remove> [args]" }));
      process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith("agentbridge-todo.ts") ||
  process.argv[1]?.endsWith("agentbridge-todo.js");
if (isDirectRun) main();
