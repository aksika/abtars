/**
 * Post-install/update health summary — detect missing external deps.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

interface HealthItem {
  ok: boolean;
  label: string;
  hint?: string;
}

function checkOllama(): HealthItem {
  try {
    execFileSync("ollama", ["--version"], { timeout: 5000, stdio: "pipe" });
    return { ok: true, label: "Ollama" };
  } catch {
    return { ok: false, label: "Ollama (memory embeddings disabled)", hint: "Install: curl -fsSL https://ollama.com/install.sh | sh" };
  }
}

function checkEmbeddingModel(): HealthItem {
  try {
    const out = execFileSync("ollama", ["list"], { timeout: 10000, stdio: "pipe", encoding: "utf-8" });
    if (out.includes("nomic-embed-text")) {
      return { ok: true, label: "Embedding model (nomic-embed-text)" };
    }
    return { ok: false, label: "Embedding model missing", hint: "Run: ollama pull nomic-embed-text" };
  } catch {
    return { ok: false, label: "Embedding model (ollama not reachable)", hint: "Start ollama, then: ollama pull nomic-embed-text" };
  }
}

function checkSqliteVec(home: string): HealthItem {
  const sharedNm = join(homedir(), ".local", "lib", "node_modules", "sqlite-vec");
  if (existsSync(sharedNm)) {
    return { ok: true, label: "sqlite-vec (vector search)" };
  }
  const abmindLib = join(process.env["ABMIND_HOME"] ?? join(homedir(), ".abmind"), "lib", "node_modules", "sqlite-vec");
  const bundleNm = join(home, "current", "node_modules", "sqlite-vec");
  if (existsSync(abmindLib) || existsSync(bundleNm)) {
    return { ok: true, label: "sqlite-vec (vector search)" };
  }
  return { ok: false, label: "sqlite-vec (falling back to brute-force search)", hint: "Run: abtars deps install" };
}

export function printHealthSummary(home: string): void {
  const items: HealthItem[] = [
    { ok: true, label: `Node.js ${process.versions.node}` },
    checkOllama(),
    checkEmbeddingModel(),
    checkSqliteVec(home),
  ];

  process.stdout.write("\n── Dependency health ──\n");
  for (const item of items) {
    const icon = item.ok ? "✓" : "⚠️ ";
    process.stdout.write(`  ${icon} ${item.label}\n`);
    if (item.hint) process.stdout.write(`     ${item.hint}\n`);
  }
  process.stdout.write("\n");
}
