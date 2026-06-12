/**
 * abtars-autofix — manage self-healer fix rules (reads from sha-policy).
 * Usage: abtars-autofix list|test [options]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AB_HOME = process.env["ABTARS_HOME"] || join(process.env["HOME"] || "~", ".abtars");

interface FixRule { pattern: string; command: string[]; cooldownMin: number; verified?: boolean; createdAt?: string }
interface PolicyFile { fixes?: FixRule[] }

function loadAll(): FixRule[] {
  const core: FixRule[] = (() => { try { return (JSON.parse(readFileSync(join(AB_HOME, "config", "sha-policy.json"), "utf-8")) as PolicyFile).fixes ?? []; } catch { return []; } })();
  const self: FixRule[] = (() => { try { return (JSON.parse(readFileSync(join(AB_HOME, "config", "sha-policy-self.json"), "utf-8")) as PolicyFile).fixes ?? []; } catch { return []; } })();
  const corePatterns = new Set(core.map(f => f.pattern));
  return [...core, ...self.filter(f => !corePatterns.has(f.pattern))];
}

const args = process.argv.slice(2);
const cmd = args[0];

function getArg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (cmd === "list") {
  const rules = loadAll();
  if (rules.length === 0) { console.log("No fix rules."); process.exit(0); }
  for (const r of rules) {
    const src = r.createdAt ? "(self)" : "(core)";
    const v = r.verified === false ? " ⚠️unverified" : "";
    console.log(`• "${r.pattern}" → ${r.command.join(" ")} (${r.cooldownMin}min) ${src}${v}`);
  }
} else if (cmd === "test") {
  const pattern = getArg("pattern");
  if (!pattern) { console.error("Usage: abtars-autofix test --pattern <p>"); process.exit(1); }
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
  console.log("Usage: abtars-autofix <list|test> [options]");
  console.log("  list                Show all fix rules (core + self)");
  console.log("  test --pattern <p>  Dry-run: show matching log lines");
  console.log("\nManage rules via /healing commands in chat or edit sha-policy-self.json directly.");
}
