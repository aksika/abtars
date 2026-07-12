import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { logInfo, logWarn } from "../logger.js";
import { configDir } from "../transport-config.js";

const TAG = "pi-config";

export interface PiExecutorConfig {
  enabled: boolean;
  command: string;
  fixedArgs: readonly string[];
  workspaceAliases: Record<string, { path: string; root?: string }>;
  allowedEnv: readonly string[];
  maxConcurrent: number;
  maxWallClockMs: number;
  abortGraceMs: number;
  projectTrust: "always" | "never";
  sessionStorageRoot: string;
  abmindPlugin: string;
  supportedRpcVersion: string;
  defaultModel?: { provider: string; modelId: string; thinking?: string };
}

export function loadPiConfig(): PiExecutorConfig | null {
  const p = resolve(configDir(), "pi-executor.json");
  if (!existsSync(p)) {
    logInfo(TAG, "No pi-executor.json found — Pi executor disabled");
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<PiExecutorConfig>;
    if (!raw.enabled) { logInfo(TAG, "Pi executor disabled in config"); return null; }
    if (!raw.command) return null;
    if (!raw.workspaceAliases || Object.keys(raw.workspaceAliases).length === 0) return null;

    const config: PiExecutorConfig = {
      enabled: true,
      command: raw.command,
      fixedArgs: raw.fixedArgs ?? [],
      workspaceAliases: raw.workspaceAliases,
      allowedEnv: raw.allowedEnv ?? [],
      maxConcurrent: raw.maxConcurrent ?? 1,
      maxWallClockMs: raw.maxWallClockMs ?? 30 * 60 * 1000,
      abortGraceMs: raw.abortGraceMs ?? 10_000,
      projectTrust: raw.projectTrust ?? "never",
      sessionStorageRoot: raw.sessionStorageRoot ?? "",
      abmindPlugin: raw.abmindPlugin ?? "",
      supportedRpcVersion: raw.supportedRpcVersion ?? "0.1",
      defaultModel: raw.defaultModel,
    };

    logInfo(TAG, `Pi executor loaded: ${config.command} (${Object.keys(config.workspaceAliases).length} aliases, max ${config.maxConcurrent} concurrent)`);
    return config;
  } catch (err) {
    logWarn(TAG, `Failed to load pi-executor.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function resolveAndValidateWorkspace(alias: string, config: PiExecutorConfig): { canonicalPath: string; error?: string } {
  const mapping = config.workspaceAliases[alias];
  if (!mapping) return { canonicalPath: "", error: `Unknown workspace alias "${alias}"` };
  if (!isAbsolute(mapping.path)) return { canonicalPath: "", error: `Path must be absolute` };
  if (!existsSync(mapping.path)) return { canonicalPath: "", error: `Path "${mapping.path}" does not exist` };
  try {
    const canonical = realpathSync(mapping.path);
    const st = statSync(canonical);
    if (!st.isDirectory()) return { canonicalPath: "", error: `Not a directory` };
    if (mapping.root) {
      const root = resolve(mapping.root);
      if (!existsSync(root)) return { canonicalPath: "", error: `Root "${root}" not found` };
      const canonicalRoot = realpathSync(root);
      if (!canonical.startsWith(canonicalRoot)) return { canonicalPath: "", error: `Escapes root "${canonicalRoot}"` };
    }
    return { canonicalPath: canonical };
  } catch (err) {
    return { canonicalPath: "", error: `Resolution failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function buildTrustArgs(config: PiExecutorConfig): string[] {
  return config.projectTrust === "always" ? ["--approve"] : ["--no-approve"];
}

export function buildPluginArgs(config: PiExecutorConfig): string[] {
  if (!config.abmindPlugin) return [];
  return ["--extension", config.abmindPlugin];
}
