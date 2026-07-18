import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir, homedir } from "node:os";
import { afterAll } from "vitest";

/** A captured environment snapshot: per-key record of whether it was set and its value. */
export type EnvSnapshot = ReadonlyMap<string, { wasSet: boolean; value: string }>;

/**
 * Restore `env` to match `snapshot`: previously-set keys get their value back
 * (even if that value was the empty string), previously-unset keys are deleted.
 * Pure and side-effect-free aside from mutating the passed `env` object, so the
 * unset-vs-empty restoration semantics are unit-testable without process gymnastics.
 */
export function restoreEnvSnapshot(env: NodeJS.ProcessEnv, snapshot: EnvSnapshot): void {
  for (const [key, record] of snapshot) {
    if (record.wasSet) env[key] = record.value;
    else delete env[key];
  }
}

export interface TestRuntimeSandbox {
  root: string;
  home: string;
  abtarsHome: string;
  abmindHome: string;
  releases: string;
  bin: string;
  xdgConfig: string;
  xdgCache: string;
  xdgState: string;
}

let _currentSandbox: TestRuntimeSandbox | null = null;

const SANDBOX_VARS = [
  "HOME", "USERPROFILE", "ABTARS_HOME", "ABMIND_HOME",
  "ABTARS_RELEASES", "ABTARS_BIN",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "NODE_ENV", "NODE_PATH", "AB_TEST_SANDBOX_ROOT",
] as const;

const _originals = new Map<string, { wasSet: boolean; value: string }>();

// Idempotent: snapshot at most once per process so a accidental double-load of
// this setup module cannot capture the already-mutated env as the "original".
if (_originals.size === 0) {
  for (const key of SANDBOX_VARS) {
    _originals.set(key, {
      wasSet: key in process.env,
      value: process.env[key] ?? "",
    });
  }
}

function setupSandbox(): TestRuntimeSandbox {
  const root = mkdtempSync(join(tmpdir(), "abtars-vitest-"));
  const home = join(root, "home");
  const abtarsHome = join(home, ".abtars");
  const abmindHome = join(home, ".abmind");
  const releases = join(root, "releases");
  const bin = join(root, "bin");
  const xdgConfig = join(home, ".config");
  const xdgCache = join(home, ".cache");
  const xdgState = join(home, ".local", "state");

  for (const dir of [home, abtarsHome, abmindHome, releases, bin, xdgConfig, xdgCache, xdgState]) {
    mkdirSync(dir, { recursive: true });
  }

  // Save real HOME before overwriting — needed for native dep resolution
  const realHome = process.env.HOME || homedir();

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ABTARS_HOME = abtarsHome;
  process.env.ABMIND_HOME = abmindHome;
  process.env.ABTARS_RELEASES = releases;
  process.env.ABTARS_BIN = bin;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.XDG_CACHE_HOME = xdgCache;
  process.env.XDG_STATE_HOME = xdgState;
  process.env.NODE_ENV = "test";
  process.env.AB_TEST_SANDBOX_ROOT = root;

  // Preserve access to real host-level native deps (~/.local/lib/node_modules/)
  // which resolveNativeDep() and many test files use via homedir() paths.
  const realLocalLib = join(realHome, ".local", "lib", "node_modules");
  if (existsSync(realLocalLib)) {
    const sandboxLocalLib = join(home, ".local", "lib");
    mkdirSync(sandboxLocalLib, { recursive: true });
    try { symlinkSync(realLocalLib, join(sandboxLocalLib, "node_modules")); } catch { /* best effort */ }
  }

  const sandbox: TestRuntimeSandbox = { root, home, abtarsHome, abmindHome, releases, bin, xdgConfig, xdgCache, xdgState };
  _currentSandbox = sandbox;
  return sandbox;
}

function restoreSandbox(): void {
  restoreEnvSnapshot(process.env, _originals);
}

export function currentTestSandbox(): TestRuntimeSandbox {
  if (!_currentSandbox) throw new Error("No test sandbox is installed — is runtime-isolation.ts loaded as a setupFile?");
  return _currentSandbox;
}

export function assertSandboxPath(path: string): string {
  const sandbox = currentTestSandbox();
  // resolve() normalizes the path string but does NOT resolve symlinks, so a
  // path that reaches outside the sandbox through a symlink is NOT detected
  // here. Containment is enforced on the normalized string only: a path whose
  // normalized form leaves the sandbox root, or equals it, is rejected before
  // any I/O. (The read-only native-dep symlink installed below is the only
  // intentional in-root link and must never be a mutation target.)
  const resolved = resolve(path);
  const rel = relative(sandbox.root, resolved);
  if (rel.startsWith("..") || resolved === sandbox.root) {
    throw new Error(`Path "${path}" resolves outside the test sandbox root "${sandbox.root}"`);
  }
  return resolved;
}

const CHILD_ALLOWLIST = new Set<string>([
  "PATH", "NODE_PATH", "PATHEXT", "SystemRoot", "WINDIR",
  "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "TERM",
  "HOME", "USERPROFILE", "ABTARS_HOME", "ABMIND_HOME",
  "ABTARS_RELEASES", "ABTARS_BIN",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "NODE_ENV", "AB_TEST_SANDBOX_ROOT",
]);

export function isolatedChildEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (overrides) Object.assign(env, overrides);
  return env;
}

// Idempotent per-process setup: reuse an existing sandbox if this module is
// loaded more than once in the same worker (avoids leaking a second temp root).
const sandbox = _currentSandbox ?? setupSandbox();

afterAll(() => {
  try { rmSync(sandbox.root, { recursive: true, force: true }); } catch (err) {
    process.stderr.write(`[runtime-isolation] failed to remove sandbox ${sandbox.root}: ${err}\n`);
  }
  restoreSandbox();
  _currentSandbox = null;
});
