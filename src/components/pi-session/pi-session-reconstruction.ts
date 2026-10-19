/**
 * Degraded reconstruction (R5): a missing/corrupt Pi store is rebuilt as a
 * NEW conversation from the authorized abmind archive and durable
 * task/project state. This is degraded reconstruction, not exact resumption
 * or automatic tool replay: tool exchanges, branch structure, compaction
 * summaries, uncommitted output, intentionally excluded records, and
 * unacknowledged crash-window output are accepted, declared losses.
 *
 * Idempotent across crash: the committed seed boundary and the current
 * input's operation key distinguish seeded history from new input. The
 * predecessor binding retires only when the successor is ready (enforced
 * by the caller). Ambiguous in-flight side effects stay with workflow
 * reconciliation; this module never reruns them.
 */

export interface PiSeedMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

/** Structural writer: production wraps a Pi SessionManager instance. */
export interface PiReconstructionWriter {
  appendSeed(message: PiSeedMessage): void;
}

export interface PiReconstructionProgress {
  seeded: number;
  currentAdmitted: boolean;
}

export interface PiReconstructionStore {
  loadProgress(conversationId: string): PiReconstructionProgress;
  saveProgress(conversationId: string, progress: PiReconstructionProgress): void;
}

export interface PiCurrentInput {
  text: string;
  timestamp: number;
  operationKey: string;
}

export interface PiReconstructionReport {
  successorId: string;
  seededCount: number;
  archiveTotal: number;
  currentInputAdmitted: boolean;
  losses: string[];
}

/** Accepted reconstruction losses, declared on every report. */
export const PI_RECONSTRUCTION_LOSSES: readonly string[] = [
  "pi-only tool exchanges",
  "branch structure",
  "compaction summaries",
  "uncommitted output",
  "records intentionally excluded from archival policy",
  "unacknowledged crash-window output",
] as const;

/** In-memory store for tests and single-process reconstructions. */
export function memoryReconstructionStore(): PiReconstructionStore & { entries: Map<string, PiReconstructionProgress> } {
  const entries = new Map<string, PiReconstructionProgress>();
  return {
    entries,
    loadProgress: (conversationId: string) => entries.get(conversationId) ?? { seeded: 0, currentAdmitted: false },
    saveProgress: (conversationId: string, progress: PiReconstructionProgress) => {
      entries.set(conversationId, { ...progress });
    },
  };
}
/**
 * Seed the successor from authorized archive context, then admit the
 * current input once. Skips already-seeded prefixes and already-admitted
 * inputs so a crash retry never duplicates history or replays work.
 */
export function reconstructPiConversation(
  writer: PiReconstructionWriter,
  store: PiReconstructionStore,
  successorId: string,
  archive: readonly PiSeedMessage[],
  currentInput: PiCurrentInput,
  isConsumed: (operationKey: string) => boolean,
  markConsumed: (operationKey: string) => void,
): PiReconstructionReport {
  const progress = store.loadProgress(successorId);
  let seeded = progress.seeded;
  for (let index = progress.seeded; index < archive.length; index++) {
    const message = archive[index];
    if (!message) continue;
    writer.appendSeed(message);
    seeded = index + 1;
    store.saveProgress(successorId, { seeded, currentAdmitted: progress.currentAdmitted });
  }
  let currentAdmitted = progress.currentAdmitted;
  if (!currentAdmitted && !isConsumed(currentInput.operationKey)) {
    writer.appendSeed({ role: "user", text: currentInput.text, timestamp: currentInput.timestamp });
    markConsumed(currentInput.operationKey);
    currentAdmitted = true;
    store.saveProgress(successorId, { seeded, currentAdmitted });
  }
  return {
    successorId,
    seededCount: seeded,
    archiveTotal: archive.length,
    currentInputAdmitted: currentAdmitted,
    losses: [...PI_RECONSTRUCTION_LOSSES],
  };
}
