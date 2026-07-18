import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import type { DoctorOutputV2, ProbeResult, DoctorFixOutputV2 } from "./doctor-types.js";

const ICON: Record<string, string> = { ok: "✓", warning: "!", failed: "✗", skipped: "~" };

export function readEnv(): Map<string, string> {
  const configDir = join(abtarsHome(), "config");
  const envPath = join(configDir, ".env");
  const map = new Map<string, string>();
  if (!existsSync(envPath)) return map;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) map.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ""));
  }
  return map;
}

function evidenceTag(evidence: string): string {
  return `[${evidence}]`;
}

function formatProbeLine(p: ProbeResult, indent: string): string {
  const ms = p.ms > 500 ? ` (${p.ms}ms)` : "";
  const detail = p.detail ? ` — ${p.detail}` : "";
  return `${indent}${ICON[p.status] ?? "?"} ${p.name}${ms}${detail}`;
}

export function renderHuman(output: DoctorOutputV2): string {
  const lines: string[] = [];

  lines.push(`abtars doctor`);
  const ver = output.abtars.commit ? `${output.abtars.version}-${output.abtars.commit}` : output.abtars.version;
  if (ver !== "?-?") lines.push(`Version: ${ver}`);
  lines.push(`Doctor schema: ${output.schemaVersion}`);
  lines.push("");

  const layerOrder: Array<{ key: string; label: string }> = [
    { key: "body", label: "Body" },
    { key: "heart", label: "Heart" },
    { key: "brain", label: "Brain" },
    { key: "soul", label: "Soul" },
    { key: "tribe", label: "Tribe" },
  ];

  for (const layer of layerOrder) {
    const probes = (output.layers as Record<string, ProbeResult[]>)[layer.key];
    if (!probes || probes.length === 0) continue;
    lines.push(`${layer.label}:`);
    for (const p of probes) {
      let line = formatProbeLine(p, "  ");
      const statusPrefix = p.status === "warning" ? "!" : ICON[p.status] ?? "?";
      line = line.replace(/^  [✓!✗~]/, `  ${statusPrefix}`);
      line += ` ${evidenceTag(p.evidence)}`;
      lines.push(line);
    }
  }

  lines.push("");
  const s = output.summary;
  lines.push(`Summary: ${s.ok} ok, ${s.warning} warnings, ${s.failed} failed, ${s.skipped} skipped (${(output.totalMs / 1000).toFixed(1)}s)`);

  const allProbes = Object.values(output.layers).flat();
  const failedProbes = allProbes.filter(p => p.status === "failed");
  const warningProbes = allProbes.filter(p => p.status === "warning");

  if (failedProbes.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const p of failedProbes) {
      lines.push(`  ✗ ${p.name}: ${p.detail}`);
      if (p.remediation) lines.push(`    → ${p.remediation}`);
    }
  }

  if (warningProbes.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const p of warningProbes) {
      lines.push(`  ! ${p.name}: ${p.detail}`);
      if (p.remediation) lines.push(`    → ${p.remediation}`);
    }
  }

  const seenRemediations = new Set<string>();
  const allActionable = [...failedProbes, ...warningProbes].filter(p => p.remediation);
  const deduplicated = allActionable.filter(p => {
    if (seenRemediations.has(p.remediation!)) return false;
    seenRemediations.add(p.remediation!);
    return true;
  });
  if (deduplicated.length > 0) {
    lines.push("");
    lines.push("Actions:");
    for (const p of deduplicated) {
      lines.push(`  • ${p.remediation}`);
    }
  }

  return lines.join("\n");
}

export function renderJson(output: DoctorOutputV2): string {
  return JSON.stringify(output, null, 2);
}

export function renderFixHuman(result: DoctorFixOutputV2): string {
  const lines: string[] = [];
  lines.push("Fixes:");
  for (const f of result.fixes) {
    const icon = f.outcome === "applied" ? "+" : f.outcome === "refused" ? "-" : "x";
    lines.push(`  [${icon}] ${f.action}${f.reason ? ` — ${f.reason}` : ""}`);
  }
  if (result.fixes.length > 0) lines.push(`\n${result.fixes.filter(f => f.outcome === "applied").length} fix(es) applied.\n`);
  lines.push(renderHuman(result.after));

  const finalFailed = Object.values(result.after.layers).flat().filter(p => p.status === "failed").length;
  const fixFailed = result.fixes.some(f => f.outcome === "failed");
  if (fixFailed) lines.push("\nSome fixes failed — see above.");
  if (finalFailed > 0) lines.push(`\n${finalFailed} issue(s) remain after fixes.`);

  return lines.join("\n");
}

export function renderFixJson(result: DoctorFixOutputV2): string {
  return JSON.stringify(result, null, 2);
}

export function renderChatDiagnosis(output: DoctorOutputV2): string {
  const lines: string[] = [];
  lines.push(`🩺 Doctor (${output.abtars.version}${output.abtars.commit ? "-" + output.abtars.commit : ""})`);

  for (const [layerName, probes] of Object.entries(output.layers) as [string, ProbeResult[]][]) {
    if (probes.length === 0) continue;
    lines.push("");
    lines.push(`${layerName.charAt(0).toUpperCase() + layerName.slice(1)}:`);
    for (const p of probes) {
      const iconMap: Record<string, string> = { ok: "✓", warning: "⚠️", failed: "❌", skipped: "➖" };
      const icon = iconMap[p.status] ?? "❓";
      lines.push(`  ${icon} ${p.name}${p.detail ? ` — ${p.detail}` : ""}`);
    }
  }

  const s = output.summary;
  lines.push(`\n${s.ok} ok, ${s.warning} warnings, ${s.failed} failed, ${s.skipped} skipped (${(output.totalMs / 1000).toFixed(1)}s)`);
  return lines.join("\n");
}

export function renderChatFix(result: DoctorFixOutputV2): string {
  const lines: string[] = [];
  lines.push("🩺 Fix:");

  if (result.fixes.length === 0) {
    lines.push("  (nothing to fix)");
  } else {
    for (const f of result.fixes) {
      const icon = f.outcome === "applied" ? "+" : f.outcome === "refused" ? "-" : "x";
      lines.push(`  [${icon}] ${f.action}${f.reason ? ` — ${f.reason}` : ""}`);
    }
  }

  lines.push("");
  lines.push(renderChatDiagnosis(result.after));
  return lines.join("\n");
}

export function computeExitCode(output: DoctorOutputV2): number {
  return output.summary.failed > 0 ? 1 : 0;
}
