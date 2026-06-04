import { readFileSync } from "node:fs";
import { join } from "node:path";

function abtarsHome(): string {
  return process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "", ".abtars");
}

const SECRET_PATTERNS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "PASSWD"];

function isSecret(name: string): boolean {
  return SECRET_PATTERNS.some(p => name.includes(p));
}

export async function configShow(): Promise<number> {
  // Read .env file directly to show what's configured
  const envFile = join(abtarsHome(), "config", ".env");
  let lines: string[];
  try {
    lines = readFileSync(envFile, "utf-8").split("\n");
  } catch {
    process.stderr.write(`Cannot read ${envFile}\n`);
    return 1;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    const display = isSecret(key) && val.length > 4 ? val.slice(0, 4) + "****" : val;
    process.stdout.write(`${key}=${display}\n`);
  }
  return 0;
}
