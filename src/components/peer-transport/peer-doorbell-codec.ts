import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

export const DOORBELL_PORT = 5353;
export const MAX_QUERY_BYTES = 384;
export const MAX_RESPONSE_BYTES = 512;
export const TIMESTAMP_WINDOW_SEC = 60;
export const NONCES_PER_PEER = 64;
export const MAX_SOURCE_BUCKETS = 256;
export const SOURCE_BURST = 8;
export const SOURCE_REFILL_PER_MIN = 30;
export const PEER_BURST = 3;
export const PEER_REFILL_PER_MIN = 12;
export const CONNECT_MIN_INTERVAL_MS = 5_000;
export const CONNECT_JITTER_MAX_MS = 500;
export const ACK_TIMEOUT_MS = 1_500;

const SIG_DOMAIN_QUERY_V1 = Buffer.from("abtars-peer-doorbell-query-v1\0", "utf-8");
const SIG_DOMAIN_ACK_V1 = Buffer.from("abtars-peer-doorbell-ack-v1\0", "utf-8");
const SUFFIX_LABELS = Buffer.from("_abtars-doorbell._udp.local", "ascii");
const MAX_NAME_BYTES = 255;
const QUERY_PAYLOAD_BYTES = 122;
const ACK_PAYLOAD_BYTES = 122;

export interface DoorbellQueryV1 {
  version: 1;
  kind: 1;
  senderSelector: Buffer;
  targetSelector: Buffer;
  timestampSec: bigint;
  nonce: Buffer;
  signature: Buffer;
}

export interface DoorbellAckV1 {
  version: 1;
  kind: 2;
  responderSelector: Buffer;
  requestNonce: Buffer;
  requestHash: Buffer;
  timestampSec: bigint;
  signature: Buffer;
}

export type ParseError =
  | { code: "too_short" | "too_long" | "bad_flags" | "bad_counts" | "compression" | "bad_label" | "bad_name" | "bad_suffix" | "bad_base32" | "bad_length" | "unknown_version" | "unknown_kind" | "bad_qtype" | "bad_qclass" | "trailing" | "response_mismatch" | "bad_ttl" | "multi_txt" | "extra_records" | "response_too_large" | "ack_query_hash" | "bad_selector_length" | "bad_nonce_length" | "bad_request_hash_length" | "bad_signature_length" | "bad_txt_string" }
  & { detail?: string };

function fail(code: ParseError["code"], detail?: string): ParseError {
  return { code, detail } as ParseError;
}

export function peerSelector(verifyKeyBase64: string): Buffer {
  const spkiDer = Buffer.from(verifyKeyBase64, "base64");
  const full = createHash("sha256").update(spkiDer).digest();
  const out = Buffer.allocUnsafe(16) as Buffer;
  full.copy(out, 0, 0, 16);
  return out;
}

export function buildSelectorMap(
  peers: Record<string, { verifyKey: string }>,
): { localSelector: Buffer; peerSelectors: Map<string, Buffer>; collisions: string[] } {
  const collisions: string[] = [];
  const peerSelectors = new Map<string, Buffer>();
  const seen = new Map<string, string>();

  for (const [name, entry] of Object.entries(peers)) {
    const sel = peerSelector(entry.verifyKey);
    const existing = seen.get(sel.toString("hex"));
    if (existing) {
      collisions.push(`${existing} and ${name} (same selector)`);
      continue;
    }
    seen.set(sel.toString("hex"), name);
    peerSelectors.set(name, sel);
  }

  return { localSelector: Buffer.alloc(0), peerSelectors, collisions };
}

export function timingSafeSelectorEq(a: Buffer, b: Buffer): boolean {
  if (a.length !== 16 || b.length !== 16) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function findPeerBySelector(
  selectors: Map<string, Buffer>,
  target: Buffer,
): string | null {
  for (const [name, sel] of selectors) {
    if (timingSafeSelectorEq(sel, target)) return name;
  }
  return null;
}

// ── Canonical binary helpers ────────────────────────────────────────────────

function u8(v: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(v);
  return b;
}

function u64BE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(v);
  return b;
}

function u16BE(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
}

function readU64BE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64BE(offset);
}

export function buildQueryCanonical(q: DoorbellQueryV1): Buffer {
  return Buffer.concat([
    SIG_DOMAIN_QUERY_V1,
    u8(q.version),
    u8(q.kind),
    q.senderSelector,
    q.targetSelector,
    u64BE(q.timestampSec),
    q.nonce,
  ]);
}

function buildAckCanonical(a: DoorbellAckV1): Buffer {
  return Buffer.concat([
    SIG_DOMAIN_ACK_V1,
    u8(a.version),
    u8(a.kind),
    a.responderSelector,
    a.requestNonce,
    a.requestHash,
    u64BE(a.timestampSec),
  ]);
}

function serializeQueryPayload(q: DoorbellQueryV1): Buffer {
  return Buffer.concat([
    u8(q.version),
    u8(q.kind),
    q.senderSelector,
    q.targetSelector,
    u64BE(q.timestampSec),
    q.nonce,
    q.signature,
  ]);
}

function serializeAckPayload(a: DoorbellAckV1): Buffer {
  return Buffer.concat([
    u8(a.version),
    u8(a.kind),
    a.responderSelector,
    a.requestNonce,
    a.requestHash,
    u64BE(a.timestampSec),
    a.signature,
  ]);
}

export function signDoorbellQuery(signingKeyBase64: string, q: DoorbellQueryV1): Buffer {
  const priv = createPrivateKey({ key: Buffer.from(signingKeyBase64, "base64"), format: "der", type: "pkcs8" });
  return cryptoSign(null, buildQueryCanonical(q), priv);
}

export function verifyDoorbellQuery(verifyKeyBase64: string, q: DoorbellQueryV1): boolean {
  const pub = createPublicKey({ key: Buffer.from(verifyKeyBase64, "base64"), format: "der", type: "spki" });
  try {
    return cryptoVerify(null, buildQueryCanonical(q), pub, q.signature);
  } catch {
    return false;
  }
}

export function signDoorbellAck(signingKeyBase64: string, a: DoorbellAckV1): Buffer {
  const priv = createPrivateKey({ key: Buffer.from(signingKeyBase64, "base64"), format: "der", type: "pkcs8" });
  return cryptoSign(null, buildAckCanonical(a), priv);
}

export function verifyDoorbellAck(verifyKeyBase64: string, a: DoorbellAckV1): boolean {
  const pub = createPublicKey({ key: Buffer.from(verifyKeyBase64, "base64"), format: "der", type: "spki" });
  try {
    return cryptoVerify(null, buildAckCanonical(a), pub, a.signature);
  } catch {
    return false;
  }
}

// ── Base32 lowercase unpadded ───────────────────────────────────────────────

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(data: Buffer): string {
  let result = "";
  let bits = 0;
  let acc = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(acc >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(acc << (5 - bits)) & 0x1f];
  }
  return result;
}

function base32Decode(s: string): ParseError | Buffer {
  const cleaned = s.toLowerCase().replace(/[^a-z2-7]/g, "");
  if (cleaned.length === 0 && s.length > 0) return fail("bad_base32", "invalid characters");
  const bits = cleaned.length * 5;
  const byteLen = Math.floor(bits / 8);
  const result = Buffer.alloc(byteLen);
  let acc = 0;
  let bitCount = 0;
  let idx = 0;
  for (const ch of cleaned) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val < 0) return fail("bad_base32", `invalid char ${ch}`);
    acc = (acc << 5) | val;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      if (idx < byteLen) result[idx++] = (acc >> bitCount) & 0xff;
    }
  }
  return result;
}

// ── DNS wire format builders/parsers ────────────────────────────────────────

function buildQueryName(b32Payload: string): Buffer {
  const labels: Buffer[] = [];
  let pos = 0;
  while (pos < b32Payload.length) {
    const chunkLen = Math.min(52, b32Payload.length - pos);
    labels.push(Buffer.from(b32Payload.slice(pos, pos + chunkLen), "ascii"));
    pos += chunkLen;
  }
  const suffixParts = SUFFIX_LABELS.toString("ascii").split(".");
  for (const part of suffixParts) {
    if (part.length > 0) labels.push(Buffer.from(part, "ascii"));
  }
  const parts: Buffer[] = [];
  for (const label of labels) {
    parts.push(Buffer.from([label.length]));
    parts.push(label);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeQuestion(qname: Buffer): Buffer {
  const qtype = u16BE(16);
  const qclass = u16BE(1);
  return Buffer.concat([qname, qtype, qclass]);
}

export function encodeQuery(q: DoorbellQueryV1): Buffer | ParseError {
  const payload = serializeQueryPayload(q);
  if (payload.length !== QUERY_PAYLOAD_BYTES) {
    return fail("bad_length", `query payload ${payload.length} != ${QUERY_PAYLOAD_BYTES}`);
  }
  const b32 = base32Encode(payload);
  const qname = buildQueryName(b32);
  if (qname.length > MAX_NAME_BYTES) {
    return fail("bad_name", `query name ${qname.length} > ${MAX_NAME_BYTES}`);
  }
  const question = encodeQuestion(qname);
  const header = Buffer.concat([
    u16BE(Math.floor(Math.random() * 65536)),
    u16BE(0x0000),
    u16BE(1),
    u16BE(0),
    u16BE(0),
    u16BE(0),
  ]);
  const packet = Buffer.concat([header, question]);
  if (packet.length > MAX_QUERY_BYTES) {
    return fail("too_long", `query ${packet.length} > ${MAX_QUERY_BYTES}`);
  }
  return packet;
}

export function encodeResponse(
  queryPacket: Buffer,
  ack: DoorbellAckV1,
): Buffer | ParseError {
  if (queryPacket.length < 12) return fail("too_short", "query < 12");

  const payload = serializeAckPayload(ack);
  if (payload.length !== ACK_PAYLOAD_BYTES) {
    return fail("bad_length", `ack payload ${payload.length} != ${ACK_PAYLOAD_BYTES}`);
  }

  const txtRdata = Buffer.concat([
    Buffer.from([payload.length]),
    payload,
  ]);

  if (txtRdata.length > 255) {
    return fail("bad_txt_string", `TXT rdata ${txtRdata.length} > 255`);
  }

  const questionStart = 12;
  const qnameEnd = findQnameEnd(queryPacket, questionStart);
  if (qnameEnd instanceof Error) return fail("bad_name", "cannot find qname end");
  const originalQuestion = queryPacket.subarray(questionStart, qnameEnd + 4);

  const answerName = Buffer.from([0xc0, 0x0c]);
  const answerRR = Buffer.concat([
    answerName,
    u16BE(16),
    u16BE(1),
    u32BE(0),
    u16BE(txtRdata.length),
    txtRdata,
  ]);

  const header = queryPacket.subarray(0, 2);
  const respHeader = Buffer.concat([
    header,
    u16BE(0x8400),
    u16BE(1),
    u16BE(1),
    u16BE(0),
    u16BE(0),
  ]);

  const response = Buffer.concat([respHeader, originalQuestion, answerRR]);
  if (response.length > Math.min(MAX_RESPONSE_BYTES, queryPacket.length * 2)) {
    return fail("response_too_large",
      `response ${response.length} > min(512, ${queryPacket.length * 2})`);
  }
  return response;
}

function findQnameEnd(packet: Buffer, start: number): number | Error {
  let pos = start;
  while (pos < packet.length) {
    const len = packet[pos]!;
    if (len === 0) return pos + 1;
    if ((len & 0xc0) === 0xc0) return pos + 2;
    if (len > 63) return new Error("bad label");
    pos += 1 + len;
    if (pos > packet.length) return new Error("truncated");
  }
  return new Error("no null terminator");
}

function u32BE(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v);
  return b;
}

// ── DNS packet parser ───────────────────────────────────────────────────────

function parseStrictQueryName(
  packet: Buffer, start: number, maxBytes: number,
): ParseError | { labels: string[]; endOffset: number; nameBytes: number } {
  const labels: string[] = [];
  let pos = start;
  let nameLen = 0;

  while (pos < packet.length) {
    const len = packet[pos]!;
    if (len === 0) { pos++; break; }
    if ((len & 0xc0) !== 0) return fail("compression", "compression pointer in question name");
    if (len > 63) return fail("bad_label", `label length ${len} > 63`);
    pos++;
    if (pos + len > packet.length) return fail("too_short", "label truncated");
    const label = packet.subarray(pos, pos + len).toString("ascii");
    if (!/^[a-z0-9_-]+$/.test(label)) return fail("bad_label", "non-ascii chars in label");
    labels.push(label);
    pos += len;
    nameLen += 1 + len;
    if (nameLen > maxBytes) return fail("bad_name", `name > ${maxBytes}`);
  }
  if (labels.length === 0) return fail("bad_name", "empty name");
  return { labels, endOffset: pos, nameBytes: nameLen };
}

function parseQueryPacket(packet: Buffer): ParseError | {
  dnsId: number;
  questionLabels: string[];
  questionEnd: number;
  rawB32: string;
  decoded: Buffer;
  parsed: DoorbellQueryV1;
} {
  if (packet.length < 12) return fail("too_short", `<12`);
  if (packet.length > MAX_QUERY_BYTES) return fail("too_long", `>${MAX_QUERY_BYTES}`);

  const flags = packet.readUInt16BE(2);
  if (flags !== 0x0000) return fail("bad_flags", `flags 0x${flags.toString(16)}`);

  const qdcount = packet.readUInt16BE(4);
  const ancount = packet.readUInt16BE(6);
  const nscount = packet.readUInt16BE(8);
  const arcount = packet.readUInt16BE(10);
  if (qdcount !== 1 || ancount !== 0 || nscount !== 0 || arcount !== 0) {
    return fail("bad_counts", `QD=${qdcount} AN=${ancount} NS=${nscount} AR=${arcount}`);
  }

  const qnameResult = parseStrictQueryName(packet, 12, MAX_NAME_BYTES);
  if ("code" in qnameResult) return qnameResult;

  const qtype = packet.readUInt16BE(qnameResult.endOffset);
  const qclass = packet.readUInt16BE(qnameResult.endOffset + 2);
  if (qtype !== 16) return fail("bad_qtype", `QTYPE=${qtype}`);
  if (qclass !== 1) return fail("bad_qclass", `QCLASS=${qclass}`);

  const questionEnd = qnameResult.endOffset + 4;
  if (questionEnd !== packet.length) return fail("trailing", `${packet.length - questionEnd} trailing bytes`);

  const labels = qnameResult.labels;
  const suffixIdx = labels.findIndex(l => l === "_abtars-doorbell");
  if (suffixIdx < 0) return fail("bad_suffix", "no _abtars-doorbell label");

  const b32Labels = labels.slice(0, suffixIdx);
  const rawB32 = b32Labels.join("");

  const decodedResult = base32Decode(rawB32);
  if ("code" in decodedResult) return decodedResult;
  const decoded = decodedResult as Buffer;

  if (decoded.length !== QUERY_PAYLOAD_BYTES) {
    return fail("bad_length", `decoded ${decoded.length} != ${QUERY_PAYLOAD_BYTES}`);
  }

  const parsed = decodeQueryPayload(decoded);
  if ("code" in parsed) return parsed;

  return { dnsId: packet.readUInt16BE(0), questionLabels: labels, questionEnd, rawB32, decoded, parsed };
}

function decodeQueryPayload(buf: Buffer): ParseError | DoorbellQueryV1 {
  let off = 0;
  const version = buf[off]; off++;
  const kind = buf[off]; off++;
  if (version !== 1) return fail("unknown_version", `version=${version}`);
  if (kind !== 1) return fail("unknown_kind", `kind=${kind}`);

  if (off + 16 > buf.length) return fail("too_short");
  const senderSelector = buf.subarray(off, off + 16); off += 16;

  if (off + 16 > buf.length) return fail("too_short");
  const targetSelector = buf.subarray(off, off + 16); off += 16;

  if (off + 8 > buf.length) return fail("too_short");
  const timestampSec = readU64BE(buf, off); off += 8;

  if (off + 16 > buf.length) return fail("too_short");
  const nonce = buf.subarray(off, off + 16); off += 16;

  if (off + 64 > buf.length) return fail("bad_signature_length");
  const signature = buf.subarray(off, off + 64);

  if (off + 64 !== buf.length) return fail("trailing", "extra bytes in payload");

  return { version, kind, senderSelector, targetSelector, timestampSec, nonce, signature };
}

function parseResponsePacket(
  packet: Buffer, queryPacket: Buffer,
): ParseError | {
  dnsId: number;
  ack: DoorbellAckV1;
} {
  if (packet.length < 12) return fail("too_short");

  const dnsId = packet.readUInt16BE(0);
  const flags = packet.readUInt16BE(2);
  if ((flags & 0x8000) === 0) return fail("bad_flags", "QR=0 (not a response)");

  const qdcount = packet.readUInt16BE(4);
  const ancount = packet.readUInt16BE(6);
  if (qdcount !== 1 || ancount < 1) return fail("bad_counts");

  const qnameResult = parseStrictQueryName(packet, 12, MAX_NAME_BYTES);
  if ("code" in qnameResult) return qnameResult;

  const questionEnd = qnameResult.endOffset + 4;

  if (queryPacket) {
    const queryQuestion = queryPacket.subarray(12);
    const respQuestion = packet.subarray(12, questionEnd);
    if (!queryQuestion.equals(respQuestion)) {
      return fail("response_mismatch", "question mismatch");
    }
  }

  let pos = questionEnd;
  for (let i = 0; i < ancount; i++) {
    if (pos >= packet.length) return fail("too_short");
    const nameLen = packet[pos]!;
    if ((nameLen & 0xc0) === 0xc0) {
      const ptr = ((nameLen & 0x3f) << 8) | packet[pos + 1]!;
      if (ptr !== 12) return fail("compression", "answer name pointer not to question");
      pos += 2;
    } else {
      const r = parseStrictQueryName(packet, pos, MAX_NAME_BYTES);
      if ("code" in r) return r;
      pos = r.endOffset;
    }

    if (pos + 10 > packet.length) return fail("too_short");
    const atype = packet.readUInt16BE(pos); pos += 2;
    const aclass = packet.readUInt16BE(pos); pos += 2;
    const ttl = packet.readUInt32BE(pos); pos += 4;
    if (atype !== 16) return fail("bad_qtype", `answer TYPE=${atype} not TXT`);
    if (aclass !== 1) return fail("bad_qclass", `answer CLASS=${aclass} not IN`);
    if (ttl !== 0) return fail("bad_ttl", `answer TTL=${ttl}`);

    const rdlength = packet.readUInt16BE(pos); pos += 2;
    if (pos + rdlength > packet.length) return fail("too_short");

    if (rdlength < 1) return fail("bad_txt_string", "empty TXT RDATA");
    const txtLen = packet[pos]!;
    if (txtLen + 1 !== rdlength) return fail("bad_txt_string", `TXT len ${txtLen} != RDATA ${rdlength}`);

    const ackPayload = packet.subarray(pos + 1, pos + rdlength);

    if (i > 0) return fail("multi_txt", "multiple TXT records");

    pos += rdlength;

    if (ackPayload.length !== ACK_PAYLOAD_BYTES) {
      return fail("bad_length", `ack payload ${ackPayload.length}`);
    }

    const decoded = decodeAckPayload(ackPayload);
    if ("code" in decoded) return decoded;

    return { dnsId, ack: decoded };
  }

  return fail("extra_records", `no answer found in ${ancount} records`);
}

function decodeAckPayload(buf: Buffer): ParseError | DoorbellAckV1 {
  let off = 0;
  const version = buf[off]; off++;
  const kind = buf[off]; off++;
  if (version !== 1) return fail("unknown_version");
  if (kind !== 2) return fail("unknown_kind");

  if (off + 16 > buf.length) return fail("bad_selector_length");
  const responderSelector = buf.subarray(off, off + 16); off += 16;

  if (off + 16 > buf.length) return fail("bad_nonce_length");
  const requestNonce = buf.subarray(off, off + 16); off += 16;

  if (off + 16 > buf.length) return fail("bad_request_hash_length");
  const requestHash = buf.subarray(off, off + 16); off += 16;

  if (off + 8 > buf.length) return fail("too_short");
  const timestampSec = readU64BE(buf, off); off += 8;

  if (off + 64 > buf.length) return fail("bad_signature_length");
  const signature = buf.subarray(off, off + 64);

  return { version, kind, responderSelector, requestNonce, requestHash, timestampSec, signature };
}

export function computeRequestHash(queryCanonical: Buffer): Buffer {
  return createHash("sha256").update(queryCanonical).digest().subarray(0, 16);
}

export function buildFreshQuery(
  signingKeyBase64: string,
  senderSelector: Buffer,
  targetSelector: Buffer,
): DoorbellQueryV1 {
  const nonce = randomBytes(16);
  const timestampSec = BigInt(Math.floor(Date.now() / 1000));
  const q: DoorbellQueryV1 = {
    version: 1,
    kind: 1,
    senderSelector,
    targetSelector,
    timestampSec,
    nonce,
    signature: Buffer.alloc(64),
  };
  q.signature = signDoorbellQuery(signingKeyBase64, q);
  return q;
}

export function buildFreshAck(
  signingKeyBase64: string,
  responderSelector: Buffer,
  queryNonce: Buffer,
  queryCanonical: Buffer,
): DoorbellAckV1 {
  const requestHash = computeRequestHash(queryCanonical);
  const timestampSec = BigInt(Math.floor(Date.now() / 1000));
  const a: DoorbellAckV1 = {
    version: 1,
    kind: 2,
    responderSelector,
    requestNonce: queryNonce,
    requestHash,
    timestampSec,
    signature: Buffer.alloc(64),
  };
  a.signature = signDoorbellAck(signingKeyBase64, a);
  return a;
}

export function parseQuery(packet: Buffer): ReturnType<typeof parseQueryPacket> {
  return parseQueryPacket(packet);
}

export function parseResponse(packet: Buffer, queryPacket: Buffer): ReturnType<typeof parseResponsePacket> {
  return parseResponsePacket(packet, queryPacket);
}
