import { createHash } from "node:crypto";
import { logWarn } from "../logger.js";
import { signRequest, verifyRequest } from "./peer-auth.js";

export interface PeerInventoryPayloadV1 {
  version: 1;
  peer: string;
  generated_at: string;
  abtars_version: string;
  protocols: string[];
  capabilities: string[];
}

export interface SignedPeerInventoryV1 {
  payload: string;
  signature: string;
  peer_id?: string;
  peer_ts?: string;
  peer_nonce?: string;
}

interface StoredInventory {
  payload: PeerInventoryPayloadV1;
  receivedAt: number;
}

const INVENTORY_SIGNATURE_DOMAIN = "abtars-peer-inventory-v1";

const MAX_PAYLOAD_BYTES = 100_000;
const MAX_CAPABILITIES = 100;
const MAX_CAPABILITY_LENGTH = 128;
const MAX_PROTOCOLS = 20;

const inventories = new Map<string, StoredInventory>();

export function buildSignedInventory(signingKey: string, peerName: string, abtarsVersion: string, capabilities: string[], protocols: string[]): SignedPeerInventoryV1 {
  const payload: PeerInventoryPayloadV1 = {
    version: 1,
    peer: peerName,
    generated_at: new Date().toISOString(),
    abtars_version: abtarsVersion,
    protocols: normalizeList(protocols, MAX_PROTOCOLS),
    capabilities: normalizeList(capabilities, MAX_CAPABILITIES),
  };
  const payloadStr = JSON.stringify(payload);
  const sig = signRequest("POST", `/${INVENTORY_SIGNATURE_DOMAIN}`, payloadStr, signingKey, peerName);
  return {
    payload: payloadStr,
    signature: sig["X-Peer-Sig"] ?? "",
    peer_id: sig["X-Peer-Id"] ?? peerName,
    peer_ts: sig["X-Peer-Ts"] ?? "",
    peer_nonce: sig["X-Peer-Nonce"] ?? "",
  };
}

export function verifyAndStoreInventory(sourcePeer: string, envelope: SignedPeerInventoryV1, verifyKey: string): boolean {
  if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
    logWarn("peer-inventory", `Invalid envelope from ${sourcePeer}`);
    return false;
  }
  if (envelope.payload.length > MAX_PAYLOAD_BYTES) {
    logWarn("peer-inventory", `Inventory payload too large from ${sourcePeer}: ${envelope.payload.length}`);
    return false;
  }
  let parsed: PeerInventoryPayloadV1;
  try {
    parsed = JSON.parse(envelope.payload) as PeerInventoryPayloadV1;
  } catch {
    logWarn("peer-inventory", `Invalid inventory JSON from ${sourcePeer}`);
    return false;
  }
  if (parsed.version !== 1) {
    logWarn("peer-inventory", `Unsupported inventory version from ${sourcePeer}: ${parsed.version}`);
    return false;
  }
  if (parsed.peer !== sourcePeer) {
    logWarn("peer-inventory", `Inventory peer mismatch: payload says ${parsed.peer}, source is ${sourcePeer}`);
    return false;
  }

  const headers: Record<string, string> = {
    "X-Peer-Id": envelope.peer_id ?? sourcePeer,
    "X-Peer-Ts": envelope.peer_ts ?? "",
    "X-Peer-Nonce": envelope.peer_nonce ?? "",
    "X-Peer-Sig": envelope.signature,
  };
  const result = verifyRequest(headers, "POST", `/${INVENTORY_SIGNATURE_DOMAIN}`, envelope.payload, verifyKey);
  if (!result.ok) {
    logWarn("peer-inventory", `Inventory signature verification failed for ${sourcePeer}: ${result.reason}`);
    return false;
  }

  inventories.set(sourcePeer, { payload: parsed, receivedAt: Date.now() });
  return true;
}

export function getPeerInventory(peerName: string): PeerInventoryPayloadV1 | undefined {
  return inventories.get(peerName)?.payload;
}

export function hasCapability(peerName: string, capability: string): boolean {
  const inv = inventories.get(peerName)?.payload;
  if (!inv) return false;
  return inv.capabilities.includes(capability.toLowerCase());
}

export function hasAllCapabilities(peerName: string, required: string[]): boolean {
  const inv = inventories.get(peerName)?.payload;
  if (!inv) return false;
  if (required.length === 0) return true;
  const invCaps = new Set(inv.capabilities);
  return required.every(c => invCaps.has(c.toLowerCase()));
}

export function getConnectedInventoryPeers(): string[] {
  return Array.from(inventories.keys());
}

export function clearInventory(peerName: string): void {
  inventories.delete(peerName);
}

export function getInventoryCapabilityHash(_signingKey: string, _peerName: string, abtarsVersion: string, capabilities: string[], protocols: string[]): string {
  const sorted = [...capabilities].sort();
  return createHash("sha256").update(JSON.stringify({ sorted, protocols, abtarsVersion })).digest("hex");
}

function normalizeList(items: string[], max: number): string[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (typeof item === "string" && item.length > 0 && item.length <= MAX_CAPABILITY_LENGTH) {
      const normal = item.trim().toLowerCase();
      if (!seen.has(normal)) {
        seen.add(normal);
        result.push(normal);
      }
    }
  }
  result.sort();
  return result.slice(0, max);
}
