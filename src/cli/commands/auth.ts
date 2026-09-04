/**
 * auth.ts — `abtars auth list|rm` CLI (#1771).
 *
 * Inspects and prunes the ActionGate whitelist (`~/.abtars/auth/rules.json`,
 * the same file the bridge uses). All file I/O delegates to the ActionGate
 * exports so bridge/CLI concurrency follows one re-read + atomic-write
 * discipline. `deny` rules are added by editing rules.json directly.
 */

import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { ActionGate } from "../../components/action-gate.js";

function usage(): void {
  process.stdout.write("Usage: abtars auth list | abtars auth rm <index>\n");
  process.stdout.write("  list            print index, category, pattern, action, createdAt per rule\n");
  process.stdout.write("  rm <index>      remove the rule at the printed index (0-based)\n");
  process.stdout.write("  (add a deny rule by editing ~/.abtars/auth/rules.json directly)\n");
}

export async function auth(args: string[]): Promise<number> {
  const subcommand = args[0] ?? "";
  const gate = new ActionGate(join(abtarsHome(), "auth"));

  if (subcommand === "list") {
    const rules = gate.listRules();
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      process.stdout.write(`${i}\t${r.category}\t${r.pattern}\t${r.action}\t${r.createdAt}\n`);
    }
    return 0;
  }

  if (subcommand === "rm") {
    const index = Number(args[1]);
    if (!Number.isInteger(index)) {
      process.stderr.write(`auth rm requires a numeric rule index (see: abtars auth list)\n`);
      usage();
      return 1;
    }
    if (!gate.removeRule(index)) {
      process.stderr.write(`no rule at index ${args[1]}\n`);
      return 1;
    }
    process.stdout.write(`removed rule ${index}\n`);
    return 0;
  }

  usage();
  return 1;
}
