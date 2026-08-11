/**
 * controller-client.ts — #1528 client for the abmind consumer fixture
 * controller. Spawns the built controller executable and speaks the NDJSON
 * protocol; never imports abmind test source into this process.
 */

import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { TIMEOUTS } from "./contracts.js";
import type { PiAcceptanceLane } from "./contracts.js";
import { SpawnedChild } from "./child-process.js";

// ── Consumer fixture controller wire contract (mirrors abmind's
//    tests/acceptance/contracts.ts V1 protocol; never imported from abmind).

export interface ConsumerFixtureDescriptorV1 {
  version: 1;
  lane: PiAcceptanceLane;
  runId: string;
  principalId: string;
  connection:
    | { mode: "local"; socketPath: string }
    | { mode: "wss"; url: string; peerId: string; signingKeyPath: string; serverCertSha256: string };
  endpointFingerprint: string;
}

export type FixtureResponseV1 =
  | { version: 1; id: string; ok: true; result?: unknown }
  | { version: 1; id: string; ok: false; failure: { stage: string; code: string; message: string } };

export class FixtureLaneBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureLaneBlockedError";
  }
}

export interface ConversationRow {
  role: string;
  content: string;
  timestamp: number;
}

export class OwnerControllerClient {
  private child: SpawnedChild;
  private lines: ReturnType<typeof createInterface>;
  private pending = new Map<string, (response: FixtureResponseV1) => void>();
  private _descriptor: ConsumerFixtureDescriptorV1 | null = null;
  private closed = false;

  private constructor(child: SpawnedChild) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const rec = parsed as Record<string, unknown>;
      if (rec["type"] === "descriptor") {
        this._descriptor = rec["descriptor"] as ConsumerFixtureDescriptorV1;
        return;
      }
      const response = parsed as FixtureResponseV1;
      const pending = this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id);
        pending(response);
      }
    });
  }

  static async spawn(abmindRoot: string, lane: PiAcceptanceLane, runId: string, logDir: string): Promise<OwnerControllerClient> {
    const controller = resolve(abmindRoot, "dist/tests/acceptance/consumer-fixture-controller.js");
    if (!existsSync(controller)) {
      throw new FixtureLaneBlockedError(`built fixture controller missing at ${controller} — build abmind first`);
    }
    const child = new SpawnedChild({
      execPath: process.execPath,
      args: [controller, "--lane", lane, "--run-id", runId],
      cwd: abmindRoot,
      env: process.env,
      logDir,
      name: "abmind-controller",
      input: true,
    });
    const client = new OwnerControllerClient(child);
    await client.waitForDescriptor();
    return client;
  }

  get descriptor(): ConsumerFixtureDescriptorV1 {
    if (!this._descriptor) throw new Error("controller descriptor not yet received");
    return this._descriptor;
  }

  get pid(): number {
    return this.child.pid;
  }

  get isAlive(): boolean {
    return !this.child.exited;
  }

  private async waitForDescriptor(timeoutMs: number = TIMEOUTS.controllerCommandMs): Promise<ConsumerFixtureDescriptorV1> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this._descriptor) {
      if (this.child.exited) {
        throw new Error(`controller exited before descriptor (code=${this.child.exitCodeValue}, signal=${this.child.signalValue})\n${this.child.stderrTail}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this._descriptor) {
      throw new Error(`controller descriptor timeout\n${this.child.stderrTail}`);
    }
    return this._descriptor;
  }

  private async command(command: Record<string, unknown>, timeoutMs: number = TIMEOUTS.controllerCommandMs): Promise<FixtureResponseV1> {
    if (this.closed) throw new Error("controller is closed");
    const id = String(command["id"] ?? `cmd-${randomUUID().slice(0, 8)}`);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`controller command ${String(command["command"])} timed out`));
      }, timeoutMs);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolvePromise(response);
      });
      this.child.stdin.write(JSON.stringify({ version: 1, id, ...command }) + "\n");
    });
  }

  async describe(): Promise<ConsumerFixtureDescriptorV1> {
    const response = await this.command({ command: "describe" });
    this.expectOk(response, "describe");
    return (response as { ok: true; result?: unknown }).result as ConsumerFixtureDescriptorV1;
  }

  async stopOwner(): Promise<void> {
    const response = await this.command({ command: "stopOwner" });
    this.expectOk(response, "stopOwner");
  }

  async startOwner(): Promise<void> {
    const response = await this.command({ command: "startOwner" });
    this.expectOk(response, "startOwner");
  }

  /** Stop and restart the same owner; resolves only after re-readiness. */
  async restartOwner(): Promise<void> {
    const response = await this.command({ command: "restartOwner" }, TIMEOUTS.ownerRecoveryMs + TIMEOUTS.controllerCommandMs);
    this.expectOk(response, "restartOwner");
  }

  async copyFailureArtifacts(stage: string): Promise<string> {
    const response = await this.command({ command: "copyFailureArtifacts", stage });
    this.expectOk(response, "copyFailureArtifacts");
    return ((response as { ok: true; result?: unknown }).result as { artifactDirectory: string }).artifactDirectory;
  }

  async conversationRows(userId: string, since: number, limit: number): Promise<ConversationRow[]> {
    const response = await this.command({ command: "conversationRows", userId, since, limit });
    this.expectOk(response, "conversationRows");
    return ((response as { ok: true; result?: unknown }).result as { rows: ConversationRow[] }).rows;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const response = await this.command({ command: "shutdown" }, 20_000);
      this.expectOk(response, "shutdown");
    } catch {
      // fall through to forced termination
    }
    if (!this.child.exited) {
      await this.child.terminate();
    }
  }

  /** Hard cleanup when the controller is unresponsive. */
  async forceCleanup(): Promise<void> {
    if (!this.child.exited) {
      await this.child.terminate();
    }
  }

  private expectOk(response: FixtureResponseV1, what: string): void {
    if (!response.ok) {
      const failure = response.failure;
      throw new Error(
        `controller ${what} failed (${failure?.stage ?? "unknown"}/${failure?.code ?? "unknown"}): ${failure?.message ?? "unknown"}`,
      );
    }
  }
}
