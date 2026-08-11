/**
 * bridge-config.ts — #1528 isolated abtars bridge configuration.
 *
 * Generates a disposable abtars home through the same files and schemas the
 * production boot consumes: transport.json, models.json, users.json, and
 * config/abmind.json (from the generic controller descriptor). The generated
 * endpoint config is validated through the production resolveAbmindEndpoint()
 * before the bridge is spawned.
 */

import { mkdirSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, rmSync, realpathSync, statSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Resolve the `pi` executable the way production boot does, but never from a
 * repository-local node_modules/.bin (which shadows the standalone install
 * with the repo's pinned dev version). Returns the canonical absolute path or
 * null when no standalone install exists.
 */
export function resolvePiExecutable(): string | null {
  const pathDirs = (process.env.PATH ?? "").split(":").filter((dir) => dir && !dir.includes("node_modules/.bin"));
  for (const dir of pathDirs) {
    const candidate = join(dir, "pi");
    try {
      const stat = statSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) {
        return realpathSync(candidate);
      }
    } catch {
      // not here — keep scanning
    }
  }
  return null;
}
import type { ConsumerFixtureDescriptorV1 } from "./controller-client.js";
import type { PiAcceptanceLane } from "./contracts.js";
import { resolveAbmindEndpoint } from "../../../components/abmind-endpoint-config.js";

export const FIXTURE_MODEL_A = "fixture-model-a";
export const FIXTURE_MODEL_B = "fixture-model-b";
export const FIXTURE_PROVIDER = "fixture";
export const FIXTURE_API_KEY_ENV = "PI_FIXTURE_API_KEY";
export const MASTER_USER_ID = "e2e-user-a";

export interface BridgeConfigResult {
  abtarsHome: string;
  workspaceDir: string;
  bridgeEnv: NodeJS.ProcessEnv;
  endpointFingerprint: string;
}

function writeRestricted(path: string, data: string): void {
  writeFileSync(path, data);
  chmodSync(path, 0o600);
}

export function buildBridgeConfig(
  runRoot: string,
  descriptor: ConsumerFixtureDescriptorV1,
  providerBaseUrl: string,
  _lane: PiAcceptanceLane,
  preferredAbmindRoot?: string,
): BridgeConfigResult {
  const abtarsHome = join(runRoot, "abtars-home");
  const configDir = join(abtarsHome, "config");
  const workspaceDir = join(runRoot, "workspace");
  const homeDir = join(runRoot, "home");
  for (const dir of [abtarsHome, configDir, workspaceDir, homeDir, join(abtarsHome, "remote")]) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }

  // ── transport.json — pi-ai route, two loopback candidates ────────────────
  writeRestricted(join(configDir, "transport.json"), JSON.stringify({
    schemaVersion: 3,
    activeRoute: "pi-ai",
    routes: {
      "pi-ai": {
        agents: {
          main: { model: FIXTURE_MODEL_A, provider: FIXTURE_PROVIDER },
        },
        fallbacks: [
          { model: FIXTURE_MODEL_B, provider: FIXTURE_PROVIDER },
        ],
      },
    },
    providers: {
      [FIXTURE_PROVIDER]: {
        transport: "api",
        endpoint: providerBaseUrl,
        apiKeyEnv: FIXTURE_API_KEY_ENV,
        apiFormat: "chat",
      },
    },
    maxTurns: 3,
    maxToolRounds: 3,
    // #1531: the steer-followup run needs three consecutive provider turns on
    // the primary candidate (initial generation + two steered generations).
    // The candidate-rotation limit must not force a fallback switch mid-run.
    maxFallbackToolRounds: 3,
  }, null, 2));

  // ── models.json — catalog consumed by /model quick and context resolution ─
  const modelEntry = () => ({
    contextWindow: 128000,
    maxOutput: 4096,
    rank: 100,
    cost: { input: 0, output: 0 },
    transports: [FIXTURE_PROVIDER],
    description: "fixture loopback model",
    status: "alive",
  });
  writeRestricted(join(configDir, "models.json"), JSON.stringify({
    [FIXTURE_MODEL_A]: modelEntry(),
    [FIXTURE_MODEL_B]: modelEntry(),
  }, null, 2));

  // ── users.json — the master user the fixture daemon also knows ───────────
  writeRestricted(join(configDir, "users.json"), JSON.stringify({
    users: [{
      userId: MASTER_USER_ID,
      displayName: "e2e-user-a",
      role: "master",
      platforms: { tui: "tui:local" },
    }],
  }, null, 2));

  // ── config/pi-executor.json — pin the standalone pi executable so a
  //    repository-local node_modules/.bin/pi never shadows it (#1528).
  const piExecutable = resolvePiExecutable();
  if (piExecutable) {
    writeRestricted(join(configDir, "pi-executor.json"), JSON.stringify({
      enabled: true,
      command: piExecutable,
      workspaceAliases: { default: { path: workspaceDir } },
    }, null, 2));
  }

  // ── config/abmind.json — from the generic descriptor only ────────────────
  if (descriptor.connection.mode === "local") {
    // The production resolver requires the socket path to resolve inside the
    // config directory; the daemon socket lives in the controller fixture, so
    // a symlink keeps the endpoint config isolated and contained.
    const link = join(configDir, "fixture-abmind.sock");
    rmSync(link, { force: true });
    symlinkSync(descriptor.connection.socketPath, link);
    writeRestricted(join(configDir, "abmind.json"), JSON.stringify({
      version: 1,
      mode: "local",
      socketPath: "fixture-abmind.sock",
    }, null, 2));
  } else {
    const keyTarget = join(configDir, "abtars-user-a.pem");
    copyFileSync(descriptor.connection.signingKeyPath, keyTarget);
    chmodSync(keyTarget, 0o600);
    writeRestricted(join(configDir, "abmind.json"), JSON.stringify({
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: descriptor.connection.url,
          peerId: descriptor.connection.peerId,
          signingKeyFile: "abtars-user-a.pem",
          serverCertSha256: descriptor.connection.serverCertSha256,
        },
      },
    }, null, 2));
  }

  // ── Production endpoint resolver must accept the generated config ────────
  const resolved = resolveAbmindEndpoint(configDir);
  if (resolved.mode !== descriptor.connection.mode) {
    throw new Error(`generated abmind.json resolved to ${resolved.mode}, expected ${descriptor.connection.mode}`);
  }

  const bridgeEnv = buildBridgeEnv(runRoot, abtarsHome, homeDir, workspaceDir, preferredAbmindRoot);
  return {
    abtarsHome,
    workspaceDir,
    bridgeEnv,
    endpointFingerprint: descriptor.endpointFingerprint,
  };
}

const OS_ENV_ALLOWLIST = [
  "PATH", "NODE_PATH", "PATHEXT", "SystemRoot", "WINDIR",
  "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "TERM",
] as const;

/**
 * True when the abmind package build carries the durable-context projection
 * capability required by the local lane (#1527). A stale dist silently
 * degrades the local route; the harness must block on it, never skip.
 */
export function abmindPackageHasDurableContext(packageDir: string): boolean {
  try {
    const clientJs = join(packageDir, "dist", "src", "abmind-client.js");
    if (!existsSync(clientJs)) return false;
    return readFileSync(clientJs, "utf-8").includes("projectConversationContext");
  } catch {
    return false;
  }
}

/**
 * Resolve the abmind package directory the way the bridge's ordered discovery
 * would (ABMIND_PATH, npm global root, legacy location). The bridge child has
 * a sandboxed HOME, so the production strategies that depend on the real home
 * (npm root config, ~/.abmind/src, ~/.local) need the explicit ABMIND_PATH
 * override. Only packages carrying the durable-context client capability are
 * acceptable; anything else is treated as missing. Returns null when no
 * usable install exists.
 */
export function resolveAbmindPackageDir(preferredRoot?: string): string | null {
  const explicit = process.env["ABMIND_PATH"]?.trim();
  if (explicit && existsSync(join(explicit, "package.json")) && abmindPackageHasDurableContext(explicit)) {
    return realpathSync(explicit);
  }
  const candidates = [
    preferredRoot ?? "",
    join(homedir(), ".abmind", "src", "abmind"),
    join(process.env["HOME"] ?? homedir(), ".abmind", "src", "abmind"),
    join(npmGlobalRoot(), "abmind"),
    join(homedir(), ".local", "lib", "node_modules", "abmind"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const pkg = join(candidate, "package.json");
      if (existsSync(pkg) && abmindPackageHasDurableContext(candidate)) {
        return realpathSync(candidate);
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function npmGlobalRoot(): string {
  try {
    return execSync("npm root -g", { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return "/nonexistent";
  }
}

function buildBridgeEnv(
  runRoot: string,
  abtarsHome: string,
  homeDir: string,
  workspaceDir: string,
  preferredAbmindRoot?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of OS_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Repository-local node_modules/.bin entries shadow the standalone `pi`
  // install with the repo's pinned dev version. Production hosts do not have
  // that shadow; scrub it so the bridge resolves the real install.
  if (env.PATH) {
    env.PATH = env.PATH.split(":").filter((dir) => !dir.includes("node_modules/.bin")).join(":");
  }
  // Keep the bridge HOME isolated while preserving access to the host's
  // already-installed native dependencies. The production resolver checks
  // ~/.local/lib/node_modules first; with a disposable HOME that path would
  // otherwise point at an empty fixture directory. This is read-only path
  // exposure, not an installation or deployment step.
  const hostNativeNodeModules = join(homedir(), ".local", "lib", "node_modules");
  env.NODE_PATH = [hostNativeNodeModules, env.NODE_PATH].filter((value): value is string => Boolean(value)).join(delimiter);
  const fixtureKey = `pi-fixture-${runRoot.split("/").pop()}`;
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.ABTARS_HOME = abtarsHome;
  env.ABMIND_HOME = join(homeDir, ".abmind");
  env.XDG_CONFIG_HOME = join(homeDir, ".config");
  env.XDG_CACHE_HOME = join(homeDir, ".cache");
  env.XDG_STATE_HOME = join(homeDir, ".local", "state");
  env.WORKING_DIR = workspaceDir;
  env.TRANSPORT_CONFIG = "transport.json";
  env.MODELS_CONFIG = "models.json";
  env[FIXTURE_API_KEY_ENV] = fixtureKey;
  // The local lane needs the abmind package for its local client; with a
  // sandboxed HOME the production discovery strategies cannot find it, so pin
  // it explicitly through the supported ABMIND_PATH override.
  const abmindPackage = resolveAbmindPackageDir(preferredAbmindRoot);
  if (abmindPackage) env.ABMIND_PATH = abmindPackage;
  env.LOG_LEVEL = "debug";
  env.LOG_FORMAT = "text";
  env.MEMORY = "abmind";
  env.ACTIVE_MEMORY = "false";
  env.PRIMING_MODEL_TOPICS = "false";
  env.TUI_ENABLED = "true";
  env.TELEGRAM_ENABLED = "false";
  env.DISCORD_ENABLED = "false";
  env.ENABLE_DASHBOARD = "false";
  env.ENABLE_AGENT_API = "false";
  env.ENABLE_ASYNC_DELEGATION = "true";
  env.SECURITY_MODE = "off";
  env.TRUST_MODE = "true";
  env.SELFHEAL_ENABLED = "false";
  env.SUPERVISION = "pi-e2e";
  env.MAX_AGENT_CALL_PER_HOUR = "10000";
  env.MAX_AGENT_CALL_PER_DAY = "100000";
  env.MAX_BACKGROUND_SESSIONS = "3";
  // Never inherit live credentials or endpoints.
  for (const key of Object.keys(env)) {
    if (key !== FIXTURE_API_KEY_ENV && /(KEY|TOKEN|SECRET|PASSWORD|ENDPOINT|URL)/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}
