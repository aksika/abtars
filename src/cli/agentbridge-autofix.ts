#!/usr/bin/env node
/**
 * agentbridge-autofix — manage self-healer auto-fix rules.
 * Usage: agentbridge-autofix list|add|remove|test [options]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AB_HOME = process.env["AGENTBRIDGE_HOME"] || join(process.env["HOME"] || "~", ".agentbridge");
const RULES_PATH = join(AB_HOME, "config", "auto-fix.json");

interface Rule { pattern: string; instruction: string; cooldownMin: number; enabled: boolean }

function load(): Rule[] {
  try { return JSON.parse(readFileSync(RULES_PATH, "utf-8")); } catch { return []; }
}

function save(rules: Rule[]): void {
  writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2) + "\n", "utf-8");
}

const args = process.argv.slice(2);
const cmd = args[0];

function getArg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (cmd === "list") {
  const rules = load();
  if (rules.length === 0) { console.log("No auto-fix rules."); process.exit(0); }
  for (const r of rules) {
    const status = r.enabled ? "✅" : "⏸";
    console.log(`${status} "${r.pattern}" → ${r.instruction.slice(0, 80)} (${r.cooldownMin}min)`);
  }
} else if (cmd === "add") {
  const pattern = getArg("pattern");
  const instruction = getArg("instruction");
  const cooldown = parseInt(getArg("cooldown") ?? "30", 10);
  if (!pattern || !instruction) { console.error("Usage: agentbridge-autofix add --pattern <p> --instruction <i> [--cooldown <min>]"); process.exit(1); }
  if (pattern.length > 200) { console.error("Pattern too long (max 200 chars)"); process.exit(1); }
  if (instruction.length > 500) { console.error("Instruction too long (max 500 chars)"); process.exit(1); }
  if (cooldown < 5) { console.error("Cooldown must be >= 5 minutes"); process.exit(1); }
  const rules = load();
  if (rules.some(r => r.pattern === pattern)) { console.error(`Duplicate pattern: "${pattern}"`); process.exit(1); }
  rules.push({ pattern, instruction, cooldownMin: cooldown, enabled: true });
  save(rules);
  console.log(`Added: "${pattern}"`);
} else if (cmd === "remove") {
  const pattern = getArg("pattern");
  if (!pattern) { console.error("Usage: agentbridge-autofix remove --pattern <p>"); process.exit(1); }
  const rules = load();
  const filtered = rules.filter(r => r.pattern !== pattern);
  if (filtered.length === rules.length) { console.error(`Pattern not found: "${pattern}"`); process.exit(1); }
  save(filtered);
  console.log(`Removed: "${pattern}"`);
} else if (cmd === "test") {
  const pattern = getArg("pattern");
  if (!pattern) { console.error("Usage: agentbridge-autofix test --pattern <p>"); process.exit(1); }
  const logDir = join(AB_HOME, "logs");
  const today = new Date().toISOString().slice(0, 10);
  try {
    const log = readFileSync(join(logDir, `bridge-${today}.log`), "utf-8");
    const matches = log.split("\n").filter(l => l.includes(" ERROR ") && l.includes(pattern));
    if (matches.length === 0) { console.log("No matching ERROR lines in today's log."); }
    else {
      console.log(`${matches.length} matching lines:`);
      for (const m of matches.slice(-10)) console.log(`  ${m.slice(0, 150)}`);
      if (matches.length > 10) console.log(`  ... and ${matches.length - 10} more`);
    }
  } catch { console.log("No log file for today."); }
} else {
  console.log("Usage: agentbridge-autofix <list|add|remove|test> [options]");
  console.log("  list                          Show all rules");
  console.log("  add --pattern <p> --instruction <i> [--cooldown <min>]");
  console.log("  remove --pattern <p>");
  console.log("  test --pattern <p>            Dry-run: show matching log lines");
}
