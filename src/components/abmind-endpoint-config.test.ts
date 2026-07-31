import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { resolveAbmindEndpoint, AbmindEndpointConfigError, type ResolvedAbmindEndpoint } from "./abmind-endpoint-config.js";

let uid = 0;

function setup(): { root: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), `abtars-endpoint-${++uid}-`));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  chmodSync(configDir, 0o700);
  return { root, configDir };
}

function writeConfig(configDir: string, data: unknown): void {
  const p = join(configDir, "abmind.json");
  writeFileSync(p, JSON.stringify(data, null, 2));
  chmodSync(p, 0o600);
}

function generateKey(configDir: string, name = "primary-ed25519.pem"): string {
  const keyPath = join(configDir, name);
  execSync(`openssl genpkey -algorithm ed25519 -out ${keyPath}`, { stdio: "ignore" });
  chmodSync(keyPath, 0o600);
  return keyPath;
}

function validPin(): string {
  return "a".repeat(64);
}

describe("resolveAbmindEndpoint", () => {
  let ctx: { root: string; configDir: string };

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  it("returns the local Unix default when the config file is absent", () => {
    const resolved = resolveAbmindEndpoint(ctx.configDir);
    expect(resolved).toEqual({ mode: "local", source: "default" });
  });

  it("parses an explicit local profile with an optional socket path", () => {
    generateKey(ctx.configDir);
    writeConfig(ctx.configDir, { version: 1, mode: "local" });
    let resolved: ResolvedAbmindEndpoint = resolveAbmindEndpoint(ctx.configDir);
    expect(resolved).toEqual({ mode: "local", source: "explicit" });

    writeConfig(ctx.configDir, { version: 1, mode: "local", socketPath: "run/mem.sock" });
    resolved = resolveAbmindEndpoint(ctx.configDir);
    expect(resolved.mode).toBe("local");
    if (resolved.mode === "local") {
      expect(resolved.socketPath).toBe(join(ctx.configDir, "run", "mem.sock"));
    }
  });

  it("rejects an absolute socket path that escapes the config directory", () => {
    writeConfig(ctx.configDir, { version: 1, mode: "local", socketPath: "/tmp/escape.sock" });
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(AbmindEndpointConfigError);
    try {
      resolveAbmindEndpoint(ctx.configDir);
    } catch (err) {
      expect((err as AbmindEndpointConfigError).code).toBe("credentials_unsafe");
    }
  });

  it("parses a wss profile with a contained signing key and canonical pin", () => {
    generateKey(ctx.configDir);
    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "primary-ed25519.pem",
          serverCertSha256: validPin(),
        },
      },
    });
    const resolved = resolveAbmindEndpoint(ctx.configDir);
    expect(resolved.mode).toBe("wss");
    if (resolved.mode === "wss") {
      expect(resolved.profileName).toBe("primary");
      expect(resolved.profile.signingKeyFile).toBe(join(ctx.configDir, "primary-ed25519.pem"));
    }
  });

  it("normalizes an uppercase pin to lowercase", () => {
    generateKey(ctx.configDir);
    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "primary-ed25519.pem",
          serverCertSha256: "A".repeat(64),
        },
      },
    });
    const resolved = resolveAbmindEndpoint(ctx.configDir);
    if (resolved.mode === "wss") {
      expect(resolved.profile.serverCertSha256).toBe("a".repeat(64));
    }
  });

  it("rejects unknown fields so misspellings cannot weaken pinning", () => {
    generateKey(ctx.configDir);
    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "primary-ed25519.pem",
          serverCertSha256: validPin(),
          serverCertSha265: validPin(),
        },
      },
    });
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/unknown field/i);
  });

  it("rejects unsupported versions, unknown modes, and malformed pins", () => {
    expect(() => resolveAbmindEndpoint(ctx.configDir)).not.toThrow();
    for (const cfg of [
      { version: 2, mode: "local" },
      { version: 1, mode: "tcp" },
      { version: 1, mode: "wss" },
    ]) {
      writeConfig(ctx.configDir, cfg);
      expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(AbmindEndpointConfigError);
    }

    generateKey(ctx.configDir);
    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "primary-ed25519.pem",
          serverCertSha256: "not-a-pin",
        },
      },
    });
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/64 lowercase hex/i);
  });

  it("rejects non-wss URL schemes and URLs with credentials", () => {
    generateKey(ctx.configDir);
    for (const url of ["http://memory.example.invalid/ws", "wss://user:pass@memory.example.invalid/ws"]) {
      writeConfig(ctx.configDir, {
        version: 1,
        mode: "wss",
        profile: "primary",
        profiles: {
          primary: {
            url,
            peerId: "abtars-host",
            signingKeyFile: "primary-ed25519.pem",
            serverCertSha256: validPin(),
          },
        },
      });
      expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(AbmindEndpointConfigError);
    }
  });

  it("rejects unsafe profile names and missing selected profiles", () => {
    generateKey(ctx.configDir);
    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "../etc/evil",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "primary-ed25519.pem",
          serverCertSha256: validPin(),
        },
      },
    });
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/unsafe/i);

    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "missing",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "primary-ed25519.pem",
          serverCertSha256: validPin(),
        },
      },
    });
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/not defined/i);
  });

  it("rejects credential paths that escape the config directory", () => {
    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "../outside.pem",
          serverCertSha256: validPin(),
        },
      },
    });
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/escapes/i);
  });

  it("rejects group/world-readable signing keys and config files", () => {
    generateKey(ctx.configDir);
    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "primary-ed25519.pem",
          serverCertSha256: validPin(),
        },
      },
    });
    chmodSync(join(ctx.configDir, "primary-ed25519.pem"), 0o644);
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/group\/world-readable/i);
    chmodSync(join(ctx.configDir, "primary-ed25519.pem"), 0o600);
    chmodSync(join(ctx.configDir, "abmind.json"), 0o644);
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/group\/world-readable/i);
  });

  it("rejects a group/world-writable config directory", () => {
    chmodSync(ctx.configDir, 0o775);
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/group\/world-writable/i);
  });

  it("rejects a malformed signing key", () => {
    writeFileSync(join(ctx.configDir, "bad.pem"), "not a key");
    chmodSync(join(ctx.configDir, "bad.pem"), 0o600);
    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "bad.pem",
          serverCertSha256: validPin(),
        },
      },
    });
    expect(() => resolveAbmindEndpoint(ctx.configDir)).toThrowError(/not a valid private key/i);
  });

  it("local mode never falls back to wss and wss never falls back to local", () => {
    generateKey(ctx.configDir);
    writeConfig(ctx.configDir, { version: 1, mode: "local" });
    expect(resolveAbmindEndpoint(ctx.configDir).mode).toBe("local");

    writeConfig(ctx.configDir, {
      version: 1,
      mode: "wss",
      profile: "primary",
      profiles: {
        primary: {
          url: "wss://memory.example.invalid/ws",
          peerId: "abtars-host",
          signingKeyFile: "primary-ed25519.pem",
          serverCertSha256: validPin(),
        },
      },
    });
    expect(resolveAbmindEndpoint(ctx.configDir).mode).toBe("wss");
  });
});
