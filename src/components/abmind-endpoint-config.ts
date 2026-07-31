/**
 * abmind endpoint configuration — abtars owns `~/.abtars/config/abmind.json`.
 *
 * Split endpoint selection from client construction: resolve a closed,
 * validated endpoint descriptor first, then build the matching client.
 *
 * - Missing file (ENOENT) → local Unix default (today's behavior).
 * - Explicit local → only local Unix transport.
 * - Explicit wss → only signed WSS. Never fall back across modes.
 * - Unknown versions/fields/modes/URL schemes, unsafe profile names,
 *   absolute or escaping credential paths, malformed keys, and malformed
 *   pins fail closed with bounded typed reason codes.
 */

import { readFileSync, statSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createPrivateKey } from "node:crypto";

const CONFIG_FILE = "abmind.json";
const HEX64_RE = /^[0-9a-f]{64}$/;
const PEER_ID_MAX = 128;
const PROFILE_NAME_MAX = 64;
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export type EndpointConfigErrorCode =
  | "config_invalid"
  | "credentials_unsafe"
  | "endpoint_unavailable"
  | "pin_mismatch"
  | "authentication_failed"
  | "negotiation_failed";

export class AbmindEndpointConfigError extends Error {
  readonly code: EndpointConfigErrorCode;

  constructor(code: EndpointConfigErrorCode, message: string) {
    super(message);
    this.name = "AbmindEndpointConfigError";
    this.code = code;
  }
}

export interface WssProfile {
  url: string;
  peerId: string;
  /** Resolved absolute path to the Ed25519 signing key file. */
  signingKeyFile: string;
  /** Canonical lowercase 64-char hex SHA-256 of the DER leaf certificate. */
  serverCertSha256: string;
}

export type ResolvedAbmindEndpoint =
  | { mode: "local"; source: "default" | "explicit"; socketPath?: string }
  | { mode: "wss"; source: "explicit"; profileName: string; profile: WssProfile };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The real config directory, rejecting group/world-writable parents. */
function strictConfigDir(configDir: string): string {
  const real = realpathSync(configDir);
  const stat = statSync(real);
  if (stat.mode & 0o022) {
    throw new AbmindEndpointConfigError(
      "credentials_unsafe",
      `config directory is group/world-writable: ${configDir} (mode ${stat.mode.toString(8)})`,
    );
  }
  if (real !== resolve(configDir)) {
    throw new AbmindEndpointConfigError("credentials_unsafe", `config directory resolves through a symlink: ${configDir}`);
  }
  return real;
}

function readConfigFile(configDir: string): unknown {
  const p = join(configDir, CONFIG_FILE);
  const real = realpathSync(p);
  const stat = statSync(real);
  if (real !== resolve(p)) {
    throw new AbmindEndpointConfigError("credentials_unsafe", `${CONFIG_FILE} is a symlink`);
  }
  if (stat.mode & 0o077) {
    throw new AbmindEndpointConfigError(
      "credentials_unsafe",
      `${CONFIG_FILE} is group/world-readable (mode ${stat.mode.toString(8)})`,
    );
  }
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as unknown;
  } catch (err) {
    throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
}

function validatePeerId(peerId: unknown, where: string): string {
  if (typeof peerId !== "string" || peerId.length === 0 || peerId.length > PEER_ID_MAX) {
    throw new AbmindEndpointConfigError("config_invalid", `${where}: invalid peerId`);
  }
  return peerId;
}

function validateProfileName(name: string): string {
  if (name.length === 0 || name.length > PROFILE_NAME_MAX || !PROFILE_NAME_RE.test(name)) {
    throw new AbmindEndpointConfigError("config_invalid", `profile name is unsafe: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Resolve a relative credential path beneath the real config directory. */
function resolveContainedPath(configDir: string, rawPath: string, where: string): string {
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(configDir, rawPath);
  const rel = relative(resolve(configDir), resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new AbmindEndpointConfigError("credentials_unsafe", `${where}: credential path escapes the config directory`);
  }
  return resolved;
}

function validateSigningKey(configDir: string, rawPath: unknown, where: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new AbmindEndpointConfigError("config_invalid", `${where}: signingKeyFile must be a non-empty string`);
  }
  const resolved = resolveContainedPath(configDir, rawPath, where);
  if (!existsSync(resolved)) {
    throw new AbmindEndpointConfigError("endpoint_unavailable", `${where}: signing key not found: ${resolved}`);
  }
  const real = realpathSync(resolved);
  if (real !== resolved) {
    throw new AbmindEndpointConfigError("credentials_unsafe", `${where}: signing key resolves through a symlink`);
  }
  const stat = statSync(real);
  if (!stat.isFile()) {
    throw new AbmindEndpointConfigError("credentials_unsafe", `${where}: signing key is not a regular file`);
  }
  if (stat.mode & 0o077) {
    throw new AbmindEndpointConfigError(
      "credentials_unsafe",
      `${where}: signing key is group/world-readable (mode ${stat.mode.toString(8)})`,
    );
  }
  try {
    createPrivateKey(readFileSync(real, "utf-8"));
  } catch {
    throw new AbmindEndpointConfigError("config_invalid", `${where}: signing key is not a valid private key`);
  }
  return real;
}

function validatePin(rawPin: unknown, where: string): string {
  if (typeof rawPin !== "string" || !HEX64_RE.test(rawPin.trim().toLowerCase())) {
    throw new AbmindEndpointConfigError("config_invalid", `${where}: serverCertSha256 must be 64 lowercase hex characters`);
  }
  return rawPin.trim().toLowerCase();
}

function validateWssUrl(rawUrl: unknown, where: string): string {
  if (typeof rawUrl !== "string") {
    throw new AbmindEndpointConfigError("config_invalid", `${where}: url must be a string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AbmindEndpointConfigError("config_invalid", `${where}: url is not a valid URL`);
  }
  if (parsed.protocol !== "wss:") {
    throw new AbmindEndpointConfigError("config_invalid", `${where}: url must use the wss: scheme`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new AbmindEndpointConfigError("config_invalid", `${where}: url must not carry credentials or a fragment`);
  }
  return rawUrl;
}

function parseWssProfile(configDir: string, profileName: string, rawProfile: unknown): WssProfile {
  if (!isRecord(rawProfile)) {
    throw new AbmindEndpointConfigError("config_invalid", `profiles.${profileName}: must be an object`);
  }
  const known = new Set(["url", "peerId", "signingKeyFile", "serverCertSha256"]);
  for (const key of Object.keys(rawProfile)) {
    if (!known.has(key)) {
      throw new AbmindEndpointConfigError("config_invalid", `profiles.${profileName}: unknown field ${JSON.stringify(key)}`);
    }
  }
  return {
    url: validateWssUrl(rawProfile["url"], `profiles.${profileName}`),
    peerId: validatePeerId(rawProfile["peerId"], `profiles.${profileName}`),
    signingKeyFile: validateSigningKey(configDir, rawProfile["signingKeyFile"], `profiles.${profileName}`),
    serverCertSha256: validatePin(rawProfile["serverCertSha256"], `profiles.${profileName}`),
  };
}

/**
 * Resolve the abmind endpoint descriptor from an explicit abtars config
 * directory. Only a missing config file yields the local Unix default;
 * every other failure is a typed configuration error.
 */
export function resolveAbmindEndpoint(configDir: string): ResolvedAbmindEndpoint {
  const realDir = strictConfigDir(configDir);
  const configFilePath = join(realDir, CONFIG_FILE);

  if (!existsSync(configFilePath)) {
    return { mode: "local", source: "default" };
  }

  const raw = readConfigFile(realDir);

  if (!isRecord(raw)) {
    throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: must be a JSON object`);
  }

  const known = new Set(["version", "mode", "socketPath", "profile", "profiles"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: unknown field ${JSON.stringify(key)}`);
    }
  }

  if (raw["version"] !== 1) {
    throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: unsupported version ${JSON.stringify(raw["version"])}`);
  }

  const mode = raw["mode"];
  if (mode === "local") {
    let socketPath: string | undefined;
    if (raw["socketPath"] !== undefined) {
      if (typeof raw["socketPath"] !== "string" || raw["socketPath"].length === 0) {
        throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: socketPath must be a non-empty string`);
      }
      if (raw["profile"] !== undefined || raw["profiles"] !== undefined) {
        throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: local mode must not define profiles`);
      }
      socketPath = resolveContainedPath(realDir, raw["socketPath"], CONFIG_FILE);
    }
    return { mode: "local", source: "explicit", socketPath };
  }

  if (mode === "wss") {
    const profileName = raw["profile"];
    if (typeof profileName !== "string" || profileName.length === 0) {
      throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: wss mode requires a profile name`);
    }
    validateProfileName(profileName);
    if (!isRecord(raw["profiles"])) {
      throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: wss mode requires a profiles object`);
    }
    const profileNames = Object.keys(raw["profiles"]);
    for (const name of profileNames) validateProfileName(name);
    if (!profileNames.includes(profileName)) {
      throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: profile ${JSON.stringify(profileName)} is not defined`);
    }
    if (raw["socketPath"] !== undefined) {
      throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: wss mode must not define socketPath`);
    }
    const profile = parseWssProfile(realDir, profileName, (raw["profiles"] as Record<string, unknown>)[profileName]);
    return { mode: "wss", source: "explicit", profileName, profile };
  }

  throw new AbmindEndpointConfigError("config_invalid", `${CONFIG_FILE}: unsupported mode ${JSON.stringify(mode)}`);
}
