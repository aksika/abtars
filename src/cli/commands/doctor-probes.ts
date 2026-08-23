import { existsSync, readFileSync, lstatSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";


import { abtarsHome, abtarsRoot, abmindHome, getDeployedVersion } from "../../paths.js";
import { resolveAbmindPackageDir } from "../../utils/abmind-lazy.js";
import { pathToFileURL } from "node:url";
import { readEnv } from "./doctor-render.js";
import { getPiVersion } from "./pi-version-access.js";
import { describeSoulInputs } from "../../components/soul-input-manifest.js";
import { readSnapshot } from "../../components/runtime-health-snapshot.js";
import { readSecretResult } from "../../components/secrets.js";
import { KANBAN_STALE_CANDIDATE_MS } from "../../components/executor-progress.js";
import { createMemoryRuntimeFromEndpoint, AbmindModuleMissingError, MemoryEndpointUnavailableError, type MemoryRuntimeFactoryResult } from "../../boot/phase-memory.js";
import { resolveAbmindEndpoint, AbmindEndpointConfigError, type ResolvedAbmindEndpoint } from "../../components/abmind-endpoint-config.js";
import type { ProbeResult, ProbeStatus, EvidenceLevel, DoctorOutputV2, SnapshotTrust, RuntimeHealthSnapshotV1 } from "./doctor-types.js";
import { truncate } from "./doctor-types.js";

const home = abtarsHome();
const root = abtarsRoot();


async function timedProbe(name: string, evidence: import("./doctor-types.js").EvidenceLevel, fn: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const r = await fn();
    r.ms = r.ms ?? (Date.now() - start);
    r.name = name;
    r.evidence = r.evidence ?? evidence;
    r.detail = truncate(r.detail);
    if (r.remediation) r.remediation = truncate(r.remediation);
    return r;
  } catch (err) {
    return { name, status: "failed", evidence, detail: truncate(String(err)), ms: Date.now() - start };
  }
}

// ── Helpers ──

function readJson(path: string): unknown | null {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

// ── Body Probes ──

// #1258: platform credentials resolve through the same effective source the
// bridge uses — an already-present non-empty process.env override (operator /
// service manager), then the secrets policy layer. Credential-shaped
// config/.env assignments are NOT an input: #1354 makes the secret store
// authoritative for provider credentials and forbids plaintext .env use.
// Stale TELEGRAM_TOKEN / DISCORD_TOKEN aliases are not runtime configuration
// and do not configure a platform.
const PLATFORM_TIMEOUT_MS = 5000;

type PlatformName = "telegram" | "discord";

interface PlatformDescriptor {
  name: PlatformName;
  canonical: string;
  buildRequest: (token: string) => { url: string; headers: Record<string, string> };
}

const PLATFORMS: readonly PlatformDescriptor[] = [
  {
    name: "telegram",
    canonical: "TELEGRAM_BOT_TOKEN",
    // The credential necessarily appears in Telegram's fixed getMe URL path.
    buildRequest: (token) => ({ url: `https://api.telegram.org/bot${token}/getMe`, headers: {} }),
  },
  {
    name: "discord",
    canonical: "DISCORD_BOT_TOKEN",
    buildRequest: (token) => ({ url: "https://discord.com/api/v10/users/@me", headers: { Authorization: `Bot ${token}` } }),
  },
];

function resolvePlatformCredential(canonical: string): import("../../components/secrets.js").SecretReadResult {
  const override = process.env[canonical];
  if (override !== undefined && override.length > 0) return { status: "available", value: override };
  return readSecretResult(canonical);
}

/** Verify one platform's identity endpoint; never lets a credential or raw
 *  provider error escape into a ProbeResult. */
async function verifyPlatform(p: PlatformDescriptor, token: string): Promise<ProbeResult> {
  let request: { url: string; headers: Record<string, string> };
  try {
    request = p.buildRequest(token);
  } catch {
    return { name: p.name, status: "failed", evidence: "filesystem", detail: "request build failed", ms: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLATFORM_TIMEOUT_MS);
  try {
    const res = await fetch(request.url, { headers: request.headers, signal: controller.signal });
    if (res.ok) return { name: p.name, status: "ok", evidence: "reachable", detail: "verified", ms: 0 };
    // Authoritative authentication rejection: 401/403 for either provider;
    // Telegram 404 too, because the credential is part of its fixed getMe route.
    if (res.status === 401 || res.status === 403 || (p.name === "telegram" && res.status === 404)) {
      return { name: p.name, status: "failed", evidence: "reachable", detail: "invalid token", ms: 0 };
    }
    return { name: p.name, status: "warning", evidence: "reachable", detail: `http ${res.status}`, ms: 0 };
  } catch {
    // Timeout (AbortError), network rejection, or DNS failure — bounded,
    // value-free detail. The abort signal may carry the URL (with Telegram's
    // token); it is never stringified into the result.
    return { name: p.name, status: "warning", evidence: "reachable", detail: "unreachable", ms: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function probePlatforms(): Promise<ProbeResult> {
  try {
    const results: ProbeResult[] = [];
    let requestsAttempted = 0;
    let unreadableSecrets = 0;

    for (const platform of PLATFORMS) {
      const cred = resolvePlatformCredential(platform.canonical);
      if (cred.status === "missing") continue; // absent platform — excluded from aggregation
      if (cred.status === "unreadable") {
        // Configured-but-broken: never collapse into "no platform configured".
        unreadableSecrets++;
        results.push({
          name: platform.name,
          status: "failed",
          evidence: "filesystem",
          detail: "credential unreadable",
          remediation: `Reinstall the credential in the secret store: ~/.abtars/secret/${platform.canonical}`,
          ms: 0,
        });
        continue;
      }
      requestsAttempted++;
      results.push(await verifyPlatform(platform, cred.value));
    }

    if (results.length === 0) {
      return { name: "platforms", status: "skipped", evidence: "configuration", detail: "no platform configured", ms: 0 };
    }

    const status: ProbeStatus = results.some(r => r.status === "failed")
      ? "failed"
      : results.some(r => r.status === "warning")
        ? "warning"
        : "ok";
    const evidence: EvidenceLevel = requestsAttempted > 0
      ? "reachable"
      : unreadableSecrets > 0
        ? "filesystem"
        : "configuration";
    // Only the aggregate result is rendered, so per-platform remediations are
    // surfaced on it (bounded, value-free — names the canonical secret path).
    const remediations = results.flatMap(r => r.remediation ? [r.remediation] : []);

    return {
      name: "platforms",
      status,
      evidence,
      detail: results.map(r => `${r.name}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`).join(", "),
      ...(remediations.length > 0 ? { remediation: remediations.join("; ") } : {}),
      ms: 0,
    };
  } catch {
    // Sanitize every path: timedProbe() renders an escaped error verbatim.
    return { name: "platforms", status: "failed", evidence: "filesystem", detail: "platform probe failed", ms: 0 };
  }
}

async function probeDashboard(): Promise<ProbeResult> {
  const env = readEnv();
  const enabled = process.env["ENABLE_DASHBOARD"] ?? env.get("ENABLE_DASHBOARD");
  if (enabled !== "true") return { name: "dashboard", status: "skipped", evidence: "configuration", detail: "not enabled", ms: 0 };
  // Match the dashboard server's own resolution (dashboard-config via
  // process.env after dotenv) — the port is configurable (WEB_PORT), never
  // assume 3000, and operator-set env (launchd/shell) wins over .env.
  const { loadDashboardConfig } = await import("../../components/dashboard/dashboard-config.js");
  const cfg = loadDashboardConfig({ ...Object.fromEntries(env), ...process.env });
  const port = cfg.webPort;
  const host = cfg.webHost || "127.0.0.1";
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(10000) });
    return { name: "dashboard", status: res.ok ? "ok" : "failed", evidence: "reachable", detail: `${host}:${port}`, ms: 0 };
  } catch {
    return { name: "dashboard", status: "failed", evidence: "reachable", detail: `${host}:${port} unreachable`, ms: 0 };
  }
}

async function probeSecurity(): Promise<ProbeResult> {
  const env = readEnv();
  const mode = env.get("SECURITY_MODE") || "off";
  const validModes = ["off", "guardrails", "seatbelt", "docker"];
  if (!validModes.includes(mode)) return { name: "security", status: "failed", evidence: "configuration", detail: `invalid mode: ${mode}`, ms: 0 };

  let permIssues = 0;
  const secretDir = join(home, "secret");
  try {
    const dirStat = lstatSync(secretDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      permIssues++;
    } else {
      for (const f of readdirSync(secretDir)) {
        const st = lstatSync(join(secretDir, f));
        if (st.isSymbolicLink() || !st.isFile() ||
            (typeof process.getuid === "function" && st.uid !== process.getuid()) ||
            (st.mode & 0o777) !== 0o600) permIssues++;
      }
    }
  } catch (err) {
    // A missing secret directory is a valid pre-onboarding state; any other
    // lstat/readdir failure is an unsafe/inaccessible store.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") permIssues++;
  }

  const parts = [mode];
  if (existsSync(join(home, "auth", "rules.json"))) parts.push("ActionGate");
  if (permIssues > 0) return { name: "security", status: "failed", evidence: "filesystem", detail: `${mode}, ${permIssues} file(s) not 600`, ms: 0 };
  return { name: "security", status: "ok", evidence: "configuration", detail: parts.join(", "), ms: 0 };
}

async function probeWatchdog(): Promise<ProbeResult> {
  const lock = readJson(join(home, "bridge.lock")) as Record<string, unknown> | null;
  if (!lock) return { name: "watchdog", status: "failed", evidence: "filesystem", detail: "bridge.lock missing", ms: 0 };

  const bridgePid = (lock.pid as number) ?? 0;
  const wdPid = (lock.watchdogPid as number) ?? 0;
  const bridgeAlive = bridgePid > 0 && pidAlive(bridgePid);
  const wdAlive = wdPid > 0 && pidAlive(wdPid);

  // #1711 R5/P7: an ownership-inconclusive episode must be visible to the
  // operator here — watchdog absence or ownership uncertainty is never
  // reported as a healthy supervised bridge.
  const { readSupervisorState } = await import("../../supervisor/state.js");
  const supState = readSupervisorState(home);
  const episode = supState.ok ? supState.state.ownershipEpisode : undefined;
  if (episode) {
    const ageMin = Math.max(0, Math.round((Date.now() - episode.since) / 60000));
    return {
      name: "watchdog",
      status: "warning",
      evidence: "runtime",
      detail: `${bridgePid}, wd:${wdPid}, ownership-inconclusive ${ageMin}m (${episode.reason})`,
      remediation: "Verify bridge.lock integrity and check logs/watchdog.log; resolve manually if a duplicate bridge exists",
      ms: 0,
    };
  }

  if (bridgeAlive && wdAlive) return { name: "watchdog", status: "ok", evidence: "runtime", detail: `${bridgePid}, wd:${wdPid}`, ms: 0 };
  if (!bridgeAlive && !wdAlive) return { name: "watchdog", status: "failed", evidence: "runtime", detail: `${bridgePid} dead, wd:${wdPid} dead`, remediation: "Run abtars start", ms: 0 };
  if (!wdAlive) return { name: "watchdog", status: "failed", evidence: "runtime", detail: `${bridgePid} alive, wd:${wdPid} dead`, remediation: "Check watchdog configuration", ms: 0 };
  return { name: "watchdog", status: "failed", evidence: "runtime", detail: `${bridgePid} dead, wd:${wdPid} alive`, remediation: "Bridge crash detected", ms: 0 };
}

async function probeBridge(): Promise<ProbeResult> {
  // #1711 R2/B5: doctor uses the SAME literal identity predicate and
  // enumeration as reconciliation — never a substring pgrep. Read-only: this
  // probe observes, it never signals or repairs.
  const { enumerateBridgeProcesses } = await import("../../supervisor/identity.js");
  const enumeration = enumerateBridgeProcesses(home);
  if (!enumeration.complete) {
    return { name: "bridge", status: "warning", evidence: "runtime", detail: `process enumeration failed (${enumeration.reason})`, ms: 0 };
  }
  const exact = enumeration.processes.filter((p) => p.exactTarget);
  const pids = exact.map((p) => p.pid).slice(0, 5).join(",");
  if (exact.length === 0) return { name: "bridge", status: "skipped", evidence: "runtime", detail: "no bridge running", ms: 0 };
  if (exact.length === 1) return { name: "bridge", status: "ok", evidence: "runtime", detail: `pid:${exact[0]!.pid}`, ms: 0 };
  return { name: "bridge", status: "failed", evidence: "runtime", detail: `${exact.length} bridges: ${pids}`, remediation: "Run abtars restart", ms: 0 };
}

async function probeTui(): Promise<ProbeResult> {
  const sockPath = join(home, "tui.sock");
  if (!existsSync(sockPath)) return { name: "tui", status: "skipped", evidence: "filesystem", detail: "no socket", ms: 0 };
  try {
    const { connect } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const s = connect(sockPath, () => { s.end(); resolve(); });
      // Without setTimeout the handler below never fires and a hung socket
      // blocks doctor forever.
      s.setTimeout(2000, () => { s.destroy(); reject(new Error("connect timeout")); });
      s.on("error", (e) => { s.destroy(); reject(e); });
      s.on("timeout", () => { s.destroy(); reject(new Error("connect timeout")); });
    });
    return { name: "tui", status: "ok", evidence: "reachable", detail: "socket responding", ms: 0 };
  } catch {
    return { name: "tui", status: "failed", evidence: "reachable", detail: "socket exists but not responding", ms: 0 };
  }
}

// ── Heart Probes ──

async function probeHeartbeat(): Promise<ProbeResult> {
  const lock = readJson(join(home, "bridge.lock")) as Record<string, unknown> | null;
  if (!lock?.lastHeartbeat) return { name: "heartbeat", status: "skipped", evidence: "configuration", detail: "no bridge.lock", ms: 0 };
  const ageMs = Date.now() - (lock.lastHeartbeat as number);
  const detail = ago(ageMs);
  if (ageMs > 120_000) return { name: "heartbeat", status: "failed", evidence: "runtime", detail: `stale (${detail})`, ms: 0 };
  return { name: "heartbeat", status: "ok", evidence: "runtime", detail, ms: 0 };
}

// ── Brain Probes ──

async function probeTransport(): Promise<ProbeResult> {
  const tPath = join(home, "config", "transport.json");
  const t = readJson(tPath) as Record<string, unknown> | null;
  if (!t) return { name: "transport", status: "failed", evidence: "filesystem", detail: "transport.json missing", ms: 0 };
  // v3: agents live in the active route block
  const activeRoute = t.activeRoute as string | undefined;
  const routes = t.routes as Record<string, unknown> | undefined;
  let agents: string[] = [];
  if (activeRoute && routes) {
    const routeBlock = routes[activeRoute] as Record<string, unknown> | undefined;
    if (routeBlock) {
      agents = Object.keys((routeBlock.agents as Record<string, unknown>) ?? {});
    }
  }
  if (agents.length === 0) return { name: "transport", status: "failed", evidence: "configuration", detail: "no agents configured", ms: 0 };
  return { name: "transport", status: "ok", evidence: "configuration", detail: `${agents.length} agent(s): ${agents.join(", ")}`, ms: 0 };
}

async function probeSpin(): Promise<ProbeResult> {
  const lock = readJson(join(home, "bridge.lock")) as Record<string, unknown> | null;
  if (!lock?.pid || !pidAlive(lock.pid as number)) return { name: "spin", status: "failed", evidence: "runtime", detail: "bridge not running", remediation: "Run abtars start", ms: 0 };
  return { name: "spin", status: "ok", evidence: "runtime", detail: "bridge alive", ms: 0 };
}

async function probeKanban(): Promise<ProbeResult> {
  const dbPath = join(home, "kanban", "kanban.db");
  if (!existsSync(dbPath)) return { name: "kanban", status: "skipped", evidence: "filesystem", detail: "no kanban.db", ms: 0 };
  let Db: new (path: string, opts: { readonly: boolean }) => {
    prepare: (sql: string) => { get: () => Record<string, unknown>; all: (...params: unknown[]) => Array<Record<string, unknown>> };
    close: () => void;
  };
  try {
    const { resolveNativeDep: rnd } = await import("../../utils/lazy-require.js");
    Db = rnd("better-sqlite3");
  } catch {
    return { name: "kanban", status: "skipped", evidence: "filesystem", detail: "better-sqlite3 not loadable", ms: 0 };
  }

  try {
    const db = new Db(dbPath, { readonly: true });
    const total = (db.prepare("SELECT COUNT(*) as cnt FROM kanban_board").get() as { cnt: number }).cnt;
    const byStatus = db.prepare("SELECT status, COUNT(*) as cnt FROM kanban_board GROUP BY status").all() as Array<{ status: string; cnt: number }>;
    // #1439: candidate-staleness threshold is shared with the lease-based
    // reconciler (executor-progress.ts KANBAN_STALE_CANDIDATE_MS) rather
    // than a doctor-only literal — age alone still never decides failure,
    // it only decides which cards get checked against the runtime snapshot.
    const staleCutoffIso = new Date(Date.now() - KANBAN_STALE_CANDIDATE_MS).toISOString();
    const oldRunning = db.prepare("SELECT id FROM kanban_board WHERE status='running' AND updated_at < ?").all(staleCutoffIso) as Array<{ id: number }>;
    db.close();

    if (oldRunning.length === 0) {
      const statusDetail = byStatus.map(s => `${s.status}: ${s.cnt}`).join(", ");
      return { name: "kanban", status: "ok", evidence: "filesystem", detail: `${total} cards (${statusDetail})`, ms: 0 };
    }

    const snapshotResult = readSnapshot();
    if (snapshotResult.trust === "trusted" && snapshotResult.data) {
      const activeIds = new Set(snapshotResult.data.activeCardIds);
      const abandoned = oldRunning.filter(c => !activeIds.has(c.id));

      if (abandoned.length === 0) {
        return { name: "kanban", status: "ok", evidence: "runtime", detail: `${total} cards, ${oldRunning.length} old running (verified active)`, ms: 0 };
      }
      const ids = abandoned.slice(0, 5).map(c => `#${c.id}`).join(", ");
      return {
        name: "kanban",
        status: "failed",
        evidence: "runtime",
        detail: `${total} cards, ${abandoned.length} abandoned (${ids}${abandoned.length > 5 ? ", ..." : ""})`,
        remediation: "Check active work: abtars kanban running",
        ms: 0,
      };
    }

    const ids = oldRunning.slice(0, 5).map(c => `#${c.id}`).join(", ");
    return {
      name: "kanban",
      status: "warning",
      evidence: "filesystem",
      detail: `${total} cards, ${oldRunning.length} old running unverified (${ids}${oldRunning.length > 5 ? ", ..." : ""})`,
      remediation: "Check: abtars kanban running",
      ms: 0,
    };
  } catch {
    return { name: "kanban", status: "failed", evidence: "filesystem", detail: "kanban.db query failed", ms: 0 };
  }
}

async function probeSkills(): Promise<ProbeResult> {
  const catalog = join(home, "skills", "skills_catalog.md");
  if (!existsSync(catalog)) return { name: "skills", status: "failed", evidence: "filesystem", detail: "skills_catalog.md missing", ms: 0 };
  const content = readFileSync(catalog, "utf-8");
  const count = (content.match(/^## /gm) || []).length;
  if (count === 0) return { name: "skills", status: "failed", evidence: "filesystem", detail: "catalog empty", ms: 0 };
  return { name: "skills", status: "ok", evidence: "filesystem", detail: `${count} loaded`, ms: 0 };
}

async function probeSharedDeps(): Promise<ProbeResult> {
  try {
    const abmindDir = resolveAbmindPackageDir();
    if (!abmindDir) return { name: "shared-deps", status: "skipped", evidence: "filesystem", detail: "abmind not found", ms: 0 };
    const modPath = join(abmindDir, "dist", "src", "deploy-lib", "shared-native-deps.js");
    if (!existsSync(modPath)) return { name: "shared-deps", status: "skipped", evidence: "filesystem", detail: "module not found", ms: 0 };
    const mod = await import(pathToFileURL(modPath).href) as {
      diagnoseSharedNativeDeps: () => { manifestGeneration: number; packageCount: number; lockHeld: boolean; lockOwner: string | null; packages: Array<{ name: string; onDisk: boolean }> };
    };
    const status = mod.diagnoseSharedNativeDeps();
    const detail = `gen ${status.manifestGeneration}, ${status.packageCount} pkg(s)`;
    const mismatches = status.packages.filter(p => !p.onDisk);
    if (mismatches.length > 0) {
      return { name: "shared-deps", status: "failed", evidence: "filesystem", detail: `${detail}, ${mismatches.length} missing`, ms: 0 };
    }
    return { name: "shared-deps", status: "ok", evidence: "filesystem", detail, ms: 0 };
  } catch {
    return { name: "shared-deps", status: "skipped", evidence: "filesystem", detail: "manifest not available", ms: 0 };
  }
}

async function probePi(): Promise<ProbeResult> {
  const result = getPiVersion();
  if (!result.found) {
    // #1476: a timeout means Pi is present but slow to start (boot load) —
    // transient, warn instead of failing. Hard errors still fail.
    if (result.error?.includes("timed out")) {
      return { name: "pi", status: "warning", evidence: "executable", detail: `Pi slow to start (${result.error})`, ms: 0 };
    }
    if (result.error) return { name: "pi", status: "failed", evidence: "executable", detail: `Pi unavailable (${result.error})`, remediation: "Install Pi or check PATH", ms: 0 };
    return { name: "pi", status: "warning", evidence: "executable", detail: "Pi not installed (optional)", ms: 0 };
  }
  return { name: "pi", status: "ok", evidence: "executable", detail: `Pi ${result.version}`, ms: 0 };
}

// ── Tribe Probes ──

async function probePeerApi(): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_AGENT_API") !== "true") return { name: "peer-api", status: "skipped", evidence: "configuration", detail: "not enabled", ms: 0 };
  const port = parseInt(env.get("AGENT_API_PORT") || "7100", 10);
  try {
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ port, host: "127.0.0.1" }, () => { sock.destroy(); resolve(); });
      sock.on("error", reject);
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error("timeout")); });
    });
    return { name: "peer-api", status: "ok", evidence: "reachable", detail: `:${port} listening`, ms: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout")) return { name: "peer-api", status: "failed", evidence: "reachable", detail: `:${port} timed out`, ms: 0 };
    return { name: "peer-api", status: "failed", evidence: "reachable", detail: `:${port} refused`, ms: 0 };
  }
}

async function probePeers(): Promise<ProbeResult> {
  const peersPath = join(home, "config", "peers.json");
  const peers = readJson(peersPath) as { peers?: Record<string, unknown>; self?: { signingKey?: string } } | null;
  if (!peers) return { name: "peers", status: "skipped", evidence: "configuration", detail: "peers.json missing", ms: 0 };
  if (!peers.self?.signingKey) return { name: "peers", status: "failed", evidence: "configuration", detail: "self.signingKey missing — run: abtars install", ms: 0 };

  const peerEntries = Object.entries(peers.peers ?? {});
  const peerCount = peerEntries.length;
  if (peerCount === 0) return { name: "peers", status: "skipped", evidence: "configuration", detail: "no peers (solo)", ms: 0 };

  const missingKey = peerEntries.filter(([, e]) => !(e as Record<string, unknown>).verifyKey).map(([n]) => n);
  if (missingKey.length > 0) return { name: "peers", status: "failed", evidence: "configuration", detail: `missing verifyKey: ${missingKey.join(", ")}`, ms: 0 };

  return { name: "peers", status: "ok", evidence: "configuration", detail: `${peerCount} enrolled (all keys valid)`, ms: 0 };
}

async function probeIdentity(): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_AGENT_API") !== "true") return { name: "identity", status: "skipped", evidence: "configuration", detail: "peer-api disabled", ms: 0 };

  try {
    const { loadPeerConfig } = await import("../../components/peer-config.js");
    const config = loadPeerConfig();
    const { deriveVerifyKey } = await import("../../components/peer-config.js");
    deriveVerifyKey(config.self.signingKey);
    return { name: "identity", status: "ok", evidence: "authenticated", detail: "signing key valid", ms: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "identity", status: "failed", evidence: "configuration", detail: truncate(msg), ms: 0 };
  }
}

async function probeRoutes(snapshot: { trust: SnapshotTrust; data: RuntimeHealthSnapshotV1 | null }): Promise<ProbeResult> {
  if (snapshot.trust !== "trusted" || !snapshot.data) {
    return { name: "routes", status: "warning", evidence: "runtime", detail: snapshot.trust === "missing" ? "no runtime snapshot" : "snapshot unavailable", ms: 0 };
  }

  const routes = snapshot.data.routes;
  const peerNames = [...new Set(routes.map(r => r.peer))];
  if (peerNames.length === 0) return { name: "routes", status: "warning", evidence: "runtime", detail: "no authenticated routes active", ms: 0 };

  const dirCounts = peerNames.map(p => {
    const pr = routes.filter(r => r.peer === p);
    const dirs = [...new Set(pr.flatMap(r => r.directions))];
    return `${p} (${dirs.join("/")})`;
  });
  return { name: "routes", status: "ok", evidence: "authenticated", detail: `${peerNames.length}/${peerNames.length} enrolled: ${dirCounts.join(", ")}`, ms: 0 };
}

async function probeDoorbell(snapshot: { trust: SnapshotTrust; data: RuntimeHealthSnapshotV1 | null }): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_AGENT_API") !== "true") return { name: "doorbell", status: "skipped", evidence: "configuration", detail: "peer-api disabled", ms: 0 };

  const peersPath = join(home, "config", "peers.json");
  const peers = readJson(peersPath) as { peers?: Record<string, unknown> } | null;
  const peerCount = Object.keys(peers?.peers ?? {}).length;
  if (peerCount === 0) return { name: "doorbell", status: "skipped", evidence: "configuration", detail: "no peers (solo)", ms: 0 };

  if (snapshot.trust !== "trusted" || !snapshot.data) {
    return { name: "doorbell", status: "warning", evidence: "runtime", detail: snapshot.trust === "missing" ? "no runtime snapshot" : "snapshot unavailable", ms: 0 };
  }

  const ds = snapshot.data.doorbell;
  switch (ds.state) {
    case "listening":
      return { name: "doorbell", status: "ok", evidence: "runtime", detail: "listening (authenticated WSS doorbell)", ms: 0 };
    case "disabled":
      return { name: "doorbell", status: "skipped", evidence: "configuration", detail: "doorbell disabled", ms: 0 };
    case "starting":
      return { name: "doorbell", status: "warning", evidence: "runtime", detail: "starting", ms: 0 };
    case "degraded":
      return { name: "doorbell", status: "failed", evidence: "runtime", detail: ds.lastError ? `degraded: ${ds.lastError}` : "degraded", ms: 0 };
  }
}

// ── Soul Probes ──

async function probeSoul(): Promise<ProbeResult> {
  // Probe disk directly: if abmind's core memory dir has the core SOUL.md,
  // memory is effectively available regardless of env flags or bridge state.
  const abmHome = abmindHome();
  const coreDir = join(abmHome, "memory", "core");
  const abmindCoreExists = existsSync(join(coreDir, "SOUL.md"));
  const memoryMode = abmindCoreExists ? "available" : "unavailable";

  const inputs = describeSoulInputs({
    memoryMode,
    abtarsHome: home,
    abtarsRoot: root,
    abmindHome: abmHome,
  });

  const issues: string[] = [];
  let status: import("./doctor-types.js").ProbeStatus = "ok";

  for (const input of inputs) {
    const exists = existsSync(input.path);
    if (!exists) {
      if (input.required) { status = "failed"; issues.push(`${input.id}: missing`); }
      else issues.push(`${input.id}: missing (optional)`);
      continue;
    }

    try {
      const st = statSync(input.path);
      if (!st.isFile()) {
        if (input.required) { status = "failed"; issues.push(`${input.id}: not a regular file`); }
        continue;
      }
      const content = readFileSync(input.path, "utf-8");
      if (content.trim().length === 0) {
        if (input.required) { status = "failed"; issues.push(`${input.id}: empty`); }
        else issues.push(`${input.id}: empty (optional)`);
        continue;
      }
    } catch {
      if (input.required) { status = "failed"; issues.push(`${input.id}: unreadable`); }
    }
  }

  if (issues.length === 0) return { name: "soul", status: "ok", evidence: "filesystem", detail: "all inputs present", ms: 0 };
  if (status === "ok" && issues.every(i => i.includes("optional"))) {
    return { name: "soul", status: "ok", evidence: "filesystem", detail: issues.join("; "), ms: 0 };
  }
  return { name: "soul", status, evidence: "filesystem", detail: truncate(issues.join("; ")), ms: 0 };
}

// #1662: package availability is not service health. The mind probe follows
// boot's production memory boundary (phase-memory): effective MEMORY provider,
// the configured endpoint (local or WSS), negotiation, and the required recall
// capability. A stopped daemon renders as failed — never a green "abmind
// loaded (in-process)" line. No daemon is started/restarted here, no service
// manager is invoked, and no SQLite or in-process memory owner is opened.
async function probeMind(): Promise<ProbeResult> {
  // Non-secret MEMORY provider: operator process.env wins over the .env file,
  // matching boot's effective resolution. Any value other than "none" means
  // memory is expected (phase-config: memoryEnabled = provider !== "none").
  const env = readEnv();
  const memoryProvider = process.env["MEMORY"] ?? env.get("MEMORY");
  if (memoryProvider === "none") {
    return { name: "mind", status: "skipped", evidence: "configuration", detail: "memory disabled", ms: 0 };
  }

  const configDir = join(home, "config");
  let endpoint: ResolvedAbmindEndpoint;
  try {
    endpoint = resolveAbmindEndpoint(configDir);
  } catch (err) {
    // Bounded configuration failure: the raw reason can carry credential
    // paths or permission detail — only the typed reason code escapes.
    const code = err instanceof AbmindEndpointConfigError ? err.code : "config_invalid";
    return { name: "mind", status: "failed", evidence: "configuration", detail: `abmind endpoint config rejected (${code})`, ms: 0 };
  }

  let factoryResult: MemoryRuntimeFactoryResult | null = null;
  try {
    factoryResult = await createMemoryRuntimeFromEndpoint(endpoint, home);
    if (!factoryResult.runtime.supports("recall")) {
      return { name: "mind", status: "failed", evidence: "runtime", detail: "abmind endpoint incompatible", ms: 0 };
    }
    return { name: "mind", status: "ok", evidence: "runtime", detail: `abmind endpoint ready (${factoryResult.mode})`, ms: 0 };
  } catch (err) {
    if (err instanceof AbmindModuleMissingError) {
      return { name: "mind", status: "failed", evidence: "executable", detail: "abmind package unavailable", remediation: "Install abmind: npm install -g abmind", ms: 0 };
    }
    if (err instanceof MemoryEndpointUnavailableError) {
      return { name: "mind", status: "failed", evidence: "reachable", detail: "abmind endpoint unavailable", ms: 0 };
    }
    // Negotiation succeeded but the endpoint lacked the core recall path — the
    // factory's capability assertion throws this stable, bounded marker.
    if (err instanceof Error && err.message.includes("negotiation did not advertise core memory capabilities")) {
      return { name: "mind", status: "failed", evidence: "runtime", detail: "abmind endpoint incompatible", ms: 0 };
    }
    return { name: "mind", status: "failed", evidence: "reachable", detail: "abmind endpoint unavailable", ms: 0 };
  } finally {
    // Doctor owns no persistent memory connection — release whatever the
    // factory left open so no socket/reconnect resources survive the probe.
    if (factoryResult) {
      try { await factoryResult.client.close(); } catch { /* best-effort */ }
    }
  }
}

// ── Runner ──

export async function runAllProbes(): Promise<DoctorOutputV2> {
  const start = Date.now();
  const versionInfo = getDeployedVersion();
  const snapshotResult = readSnapshot();

  const [body, heart, brain, soul, tribe] = await Promise.all([
    Promise.all([
      // #1258: no unconditional evidence override — the platform probe owns
      // its evidence (configuration / filesystem / reachable) so a
      // configuration-only result survives unchanged.
      timedProbe("platforms", "configuration", probePlatforms),
      timedProbe("dashboard", "reachable", probeDashboard),
      timedProbe("security", "configuration", probeSecurity),
      timedProbe("watchdog", "runtime", probeWatchdog),
      timedProbe("bridge", "runtime", probeBridge),
      timedProbe("tui", "filesystem", probeTui),
    ]),
    Promise.all([
      timedProbe("heartbeat", "runtime", probeHeartbeat),
    ]),
    Promise.all([
      timedProbe("transport", "configuration", probeTransport),
      timedProbe("spin", "runtime", probeSpin),
      timedProbe("kanban", "filesystem", probeKanban),
      timedProbe("skills", "filesystem", probeSkills),
      timedProbe("shared-deps", "filesystem", probeSharedDeps),
      timedProbe("pi", "executable", probePi),
    ]),
    Promise.all([
      timedProbe("soul", "filesystem", probeSoul),
      timedProbe("mind", "runtime", probeMind),
    ]),
    Promise.all([
      timedProbe("peer-api", "reachable", probePeerApi),
      timedProbe("peers", "configuration", probePeers),
      timedProbe("identity", "configuration", probeIdentity),
      timedProbe("routes", "runtime", () => probeRoutes(snapshotResult)),
      timedProbe("doorbell", "runtime", () => probeDoorbell(snapshotResult)),
    ]),
  ]);

  const all = [...body, ...heart, ...brain, ...soul, ...tribe];
  const ok = all.filter(r => r.status === "ok").length;
  const warning = all.filter(r => r.status === "warning").length;
  const failed = all.filter(r => r.status === "failed").length;
  const skipped = all.filter(r => r.status === "skipped").length;

  return {
    schemaVersion: "2.0",
    abtars: { version: versionInfo.version, commit: versionInfo.commit || null },
    generatedAt: new Date().toISOString(),
    totalMs: Date.now() - start,
    layers: { body, heart, brain, soul, tribe },
    summary: { ok, warning, failed, skipped },
  };
}
