/**
 * tribe.ts — abtars tribe CLI (#1293).
 *
 * Commands:
 *   abtars tribe join --peer <host:port>    — enroll with a remote peer (initiator)
 *   abtars tribe invite --peer <host:port>  — same (either side can dial; protocol is symmetric)
 *   abtars tribe status                     — print own verifyKey + list enrolled peers
 */

import { loadPeerConfig, deriveVerifyKey, bootstrapIdentity } from "../../components/peer-config.js";

export async function tribe(args: string[]): Promise<number> {
  const subcommand = args[0] ?? "status";

  switch (subcommand) {
    case "join":
    case "invite":
      return await tribeEnroll(args);
    case "status":
      return await tribeStatus();
    default:
      process.stderr.write(`Unknown tribe subcommand: ${subcommand}\nUsage: abtars tribe join --peer <host:port>\n       abtars tribe invite --peer <host:port>\n       abtars tribe status\n`);
      return 2;
  }
}

async function tribeEnroll(args: string[]): Promise<number> {
  // Parse --peer host:port
  const peerIdx = args.indexOf("--peer");
  if (peerIdx < 0 || !args[peerIdx + 1]) {
    process.stderr.write("Usage: abtars tribe join --peer <host:port>\n");
    return 1;
  }
  const peerArg = args[peerIdx + 1]!;
  const colonIdx = peerArg.lastIndexOf(":");
  if (colonIdx < 0) {
    process.stderr.write(`Invalid peer address: ${peerArg} (expected host:port)\n`);
    return 1;
  }
  const host = peerArg.slice(0, colonIdx);
  const port = parseInt(peerArg.slice(colonIdx + 1), 10);
  if (!host || isNaN(port)) {
    process.stderr.write(`Invalid peer address: ${peerArg}\n`);
    return 1;
  }

  // Ensure identity exists
  bootstrapIdentity();
  const config = loadPeerConfig();
  const selfVerifyKey = deriveVerifyKey(config.self.signingKey);

  process.stdout.write(`Enrolling with ${host}:${port}...\n`);

  const { WsPeerClient } = await import("../../components/peer-transport/ws-peer-client.js");
  const client = new WsPeerClient("__enrolling__", { host, port, verifyKey: "" });

  try {
    await client.enroll(
      config.self.tribeToken,
      config.self.signingKey,
      selfVerifyKey,
      config.self.name,
    );
    process.stdout.write(`+ Enrollment successful\n`);
    process.stdout.write(`  Own verifyKey: ${selfVerifyKey}\n`);
    process.stdout.write(`  Enrolled peer recorded at trust=1.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`x Enrollment failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function tribeStatus(): Promise<number> {
  bootstrapIdentity();
  const config = loadPeerConfig();
  const verifyKey = deriveVerifyKey(config.self.signingKey);

  process.stdout.write(`Self: ${config.self.name}\n`);
  process.stdout.write(`VerifyKey (share out-of-band for enrollment):\n  ${verifyKey}\n\n`);

  const peers = Object.entries(config.peers);
  if (peers.length === 0) {
    process.stdout.write("No enrolled peers.\n");
    return 0;
  }

  process.stdout.write(`Enrolled peers (${peers.length}):\n`);
  for (const [name, entry] of peers) {
    const trust = entry.trust ?? 0;
    const trustLabel = trust === 0 ? "quarantine" : trust === 1 ? "enrolled" : trust === 2 ? "trusted" : `owner(${trust})`;
    const transport = entry.transport ?? "http";
    process.stdout.write(`  ${name.padEnd(20)} ${entry.host}:${entry.port}  trust=${trust}(${trustLabel})  transport=${transport}\n`);
  }
  return 0;
}
