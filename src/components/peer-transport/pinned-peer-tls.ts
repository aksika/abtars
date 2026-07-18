import * as tls from "node:tls";
import * as https from "node:https";
import type { TLSSocket } from "node:tls";
import { verifyServerCert } from "./peer-auth.js";

function makeCertPem(raw: Buffer): string {
  const b64 = raw.toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export function connectPinnedPeerTls(
  options: tls.ConnectionOptions,
  identity: { peerName: string; verifyKey: string },
  onVerified: () => void,
): TLSSocket {
  const socket = tls.connect({
    ...options,
    rejectUnauthorized: false,
  });

  socket.on("secureConnect", () => {
    try {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.raw) {
        socket.destroy(new Error(`Peer ${identity.peerName}: no certificate presented`));
        return;
      }
      if (!verifyServerCert(makeCertPem(cert.raw), identity.verifyKey)) {
        socket.destroy(new Error(`Peer ${identity.peerName}: cert SPKI does not match enrolled verifyKey`));
        return;
      }
      onVerified();
    } catch (err) {
      socket.destroy(new Error(`Peer ${identity.peerName}: cert verification error: ${err instanceof Error ? err.message : String(err)}`));
    }
  });

  return socket;
}

export function createPinnedPeerHttpsAgent(
  identity: { peerName: string; verifyKey: string },
): https.Agent {
  const agent = new https.Agent({});
  (agent as any).createConnection = (options: tls.ConnectionOptions, cb?: Function) => {
    const socket = connectPinnedPeerTls(options, identity, () => {
      cb?.(null, socket);
    });
    socket.on("error", (err) => cb?.(err));
    return socket;
  };
  return agent;
}

export function createPinnedPeerWsConnection(
  identity: { peerName: string; verifyKey: string },
): (options: tls.ConnectionOptions, cb?: () => void) => TLSSocket {
  return (options: tls.ConnectionOptions, cb?: () => void) => {
    return connectPinnedPeerTls(options, identity, () => {
      cb?.();
    });
  };
}
