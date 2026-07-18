export type ProbeStatus = "ok" | "warning" | "failed" | "skipped";

export type EvidenceLevel =
  | "configuration"
  | "filesystem"
  | "executable"
  | "reachable"
  | "runtime"
  | "authenticated";

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  evidence: EvidenceLevel;
  detail: string;
  remediation?: string;
  ms: number;
}

export type LayerName = "body" | "heart" | "brain" | "soul" | "tribe";

export interface DoctorOutputV2 {
  schemaVersion: "2.0";
  abtars: { version: string; commit: string | null };
  generatedAt: string;
  totalMs: number;
  layers: Record<LayerName, ProbeResult[]>;
  summary: { ok: number; warning: number; failed: number; skipped: number };
}

export interface FixResult {
  id: string;
  probe: string;
  action: string;
  outcome: "applied" | "refused" | "failed";
  reason?: string;
}

export interface DoctorFixOutputV2 {
  schemaVersion: "2.0";
  before: DoctorOutputV2;
  fixes: FixResult[];
  after: DoctorOutputV2;
}

export type SnapshotTrust =
  | "trusted"
  | "missing"
  | "invalid"
  | "wrong-process"
  | "stale";

export interface RuntimeHealthSnapshotV1 {
  schemaVersion: 1;
  bridge: { pid: number; startedAt: number; updatedAt: number };
  peerApi: {
    state: "disabled" | "starting" | "listening" | "failed";
    lastError?: string;
  };
  doorbell: {
    state: "disabled" | "starting" | "listening" | "degraded";
    lastError?: string;
  };
  routes: Array<{
    peer: string;
    authenticated: true;
    directions: Array<"accepted" | "outbound">;
    connectedAt: number;
  }>;
  activeCardIds: number[];
}

export interface SoulInput {
  id: "main.soul" | "main.profile" | "main.notes" | "main.memory-tools" | "main.core-facts" | "main.minimal-fallback" | "orc.prompt" | "worker.prompt";
  path: string;
  required: boolean;
}

const MAX_DETAIL_BYTES = 500;

export function truncate(s: string, maxBytes = MAX_DETAIL_BYTES): string {
  const singleLine = s.replace(/\n/g, " ");
  let len = 0;
  for (let i = 0; i < singleLine.length; i++) {
    len += Buffer.byteLength(singleLine[i]!, "utf-8");
    if (len > maxBytes) return singleLine.slice(0, i) + "…";
  }
  return singleLine;
}
