import { printBanner } from "./banner.js";
import { runAllProbes } from "./doctor-probes.js";
import { runDoctorFixes } from "./doctor-fixes.js";
import { renderHuman, renderJson, renderFixHuman, renderFixJson, computeExitCode } from "./doctor-render.js";
import type { DoctorFixOutputV2 } from "./doctor-types.js";

export async function doctor(args: readonly string[] = []): Promise<number> {
  const json = args.includes("--json");
  const fix = args.includes("--fix");

  if (!json) await printBanner("doctor");

  if (fix) {
    const before = await runAllProbes();
    const fixes = runDoctorFixes(before);
    const after = await runAllProbes();

    const result: DoctorFixOutputV2 = {
      schemaVersion: "2.0",
      before,
      fixes,
      after,
    };

    if (json) {
      process.stdout.write(renderFixJson(result) + "\n");
    } else {
      process.stdout.write(renderFixHuman(result) + "\n");
    }

    const hasFailedFix = fixes.some(f => f.outcome === "failed");
    const finalFailed = after.summary.failed > 0;
    return hasFailedFix || finalFailed ? 1 : 0;
  }

  const output = await runAllProbes();

  if (json) {
    process.stdout.write(renderJson(output) + "\n");
  } else {
    process.stdout.write(renderHuman(output) + "\n");
  }

  return computeExitCode(output);
}
