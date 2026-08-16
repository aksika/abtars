#!/usr/bin/env node
/**
 * fake-kiro-cli.js — deterministic ACP CLI fixture for the Gate B E2E (#1468).
 *
 * The emergency service's only external nondeterministic boundary is the
 * model/provider CLI. This fixture speaks the ACP JSON-RPC/ndjson protocol
 * over stdio: initialize → session/new → session/prompt, echoing a fixed
 * acknowledgement. It also answers the `--version` readiness probe used by
 * validateProviderReady().
 *
 * Deliberately dumb: no tools, no sessions on disk, one fixed response text.
 * The child writes its own pid so the scenario can prove no orphan survives
 * restore/shutdown.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "fake-kiro-cli 0.0.1";

if (process.argv[2] === "--version") {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

if (process.argv[2] !== "acp") {
  process.stderr.write(`fake-kiro-cli: unexpected argv ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}

// Prove to the parent that this child is alive (and, after restore/shutdown,
// that it is gone).
const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
try {
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", "fake-kiro-cli.pid"), String(process.pid));
} catch { /* best effort */ }

let nextSession = 1;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return; // stdin keep-alive writes empty lines
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (method === undefined) return;

  const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion, agentInfo: { name: "fake-emergency", version: "0.0.1" }, agentCapabilities: {} } });
    return;
  }

  if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: `fake-sess-${nextSession++}` } });
    return;
  }

  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    const text = Array.isArray(params?.prompt)
      ? params.prompt.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")
      : String(params?.prompt ?? "");
    const ack = `EMERGENCY_ACK: ${text}`;
    // Deliver the deterministic response after a short delay so the runner can
    // prove a concurrent second turn is rejected busy, not queued.
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ack } } },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }, 300);
    return;
  }

  if (method === "session/cancel") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Unknown method — fail loudly so a protocol drift fails the E2E.
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `fake-kiro-cli: unsupported method ${method}` } });
});
