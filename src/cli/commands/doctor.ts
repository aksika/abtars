import { printBanner } from './banner.js';
/**
 * `abtars doctor` — TypeScript health probes grouped by subsystem layer.
 * --json: machine-readable output for /doctor Telegram handler.
 * --fix: diagnose + apply fixes + re-probe.
 */

import { runAllProbes, runFixes, renderHuman, renderJson } from './doctor-probes.js';

export async function doctor(args: readonly string[] = []): Promise<number> {
  const json = args.includes("--json");
  const fix = args.includes("--fix");

  if (!json) await printBanner("doctor");

  const output = await runAllProbes();

  if (fix) {
    const fixes = await runFixes();
    output.fixes = fixes;
    if (!json) {
      for (const f of fixes) {
        const icon = f.success ? "+" : "x";
        process.stdout.write(`  [${icon}] ${f.action}\n`);
      }
      if (fixes.length > 0) process.stdout.write(`\n${fixes.filter(f => f.success).length} fix(es) applied.\n\n`);
      // Re-probe after fixes
      const recheck = await runAllProbes();
      process.stdout.write(renderHuman(recheck) + "\n");
      return Object.values(recheck.layers).flat().filter(r => r.status === "failed").length > 0 ? 1 : 0;
    }
  }

  if (json) {
    process.stdout.write(renderJson(output) + "\n");
  } else {
    process.stdout.write(renderHuman(output) + "\n");
  }

  const failed = Object.values(output.layers).flat().filter(r => r.status === "failed").length;
  return failed > 0 ? 1 : 0;
}
