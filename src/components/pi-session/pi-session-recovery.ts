import { mintPiConversationId } from "./pi-conversation-identity.js";
import {
  inspectOwnedConversationFile,
  loadPiReseedProgress,
  quarantineOwnedConversationFile,
  savePiReseedProgress,
  seedWriterForSessionManager,
} from "./pi-owned-files.js";
import {
  reconstructPiConversation,
  type PiReconstructionReport,
  type PiSeedMessage,
} from "./pi-session-reconstruction.js";

/**
 * Live degraded reconstruction (R5).
 *
 * A missing or corrupt Pi session file is rebuilt as a fresh conversation
 * from the authorized archive/context actually available. Only ordinary
 * user/assistant turns enter the successor; tool exchanges remain declared
 * losses and ambiguous work is never replayed. Crash-safe: per-predecessor
 * progress files let a retry resume the same successor, skip already-seeded
 * history, and never replay the current input.
 *
 * The caller (SDK conversation store) owns SessionManager lifecycle: this
 * module inspects/quarantines/seeds through the passed surface and returns
 * the successor identity for the caller to open.
 */

export interface PiRecoveryArchiveMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface PiRecoveryArchiveQuery {
  userId: string;
  archiveSessionId: string;
  beforeMessageId: number;
  maxContext: number;
}

export interface PiRecoveryArchiveSource {
  projectArchive(input: PiRecoveryArchiveQuery): Promise<{ messages: readonly PiRecoveryArchiveMessage[] }>;
}

export interface PiRecoveryCurrentInput {
  text: string;
  timestamp: number;
  operationKey: string;
}

/** Minimal structural SessionManager surface used by recovery. */
export interface PiRecoverySessionManager {
  findById(cwd: string, id: string, sessionDir?: string): string | undefined;
  open(path: string, sessionDir?: string): {
    getSessionId(): string;
    appendMessage(message: { role: string; content: unknown; [key: string]: unknown }): string;
  };
  create(cwd: string, sessionDir?: string, options?: { id?: string }): {
    getSessionId(): string;
    appendMessage(message: { role: string; content: unknown; [key: string]: unknown }): string;
  };
}

export interface PiRecoveryPredecessor {
  conversationId: string;
  sessionDir: string;
  /** Working directory recorded at creation (findById scope). */
  cwd: string;
  /** Previously recorded file (corruption evidence when discovery misses). */
  sessionFile?: string;
}

export interface PiRecoveryRequest {
  sessionManager: PiRecoverySessionManager;
  /** Partition root for containment checks. */
  sessionStorageRoot: string;
  /** Directory for crash-safe reseed progress files. */
  progressDir: string;
  predecessor: PiRecoveryPredecessor;
  archive: PiRecoveryArchiveQuery;
  archiveSource: PiRecoveryArchiveSource;
  current: PiRecoveryCurrentInput;
  /** Durable task/project snapshot lines to preserve as user history. */
  taskEvidence?: readonly string[];
  now?: () => number;
}

export interface PiRecoveryResult extends PiReconstructionReport {
  status: "intact" | "reconstructed";
  /** Successor to open (same as predecessor when intact). */
  successorId: string;
  successorDir: string;
  taskEvidenceCount: number;
  predecessorQuarantined: string | null;
}

function toSeedMessages(
  messages: readonly PiRecoveryArchiveMessage[],
  taskEvidence: readonly string[],
  timestamp: number,
): PiSeedMessage[] {
  const seeds: PiSeedMessage[] = [];
  for (const message of messages) {
    if ((message.role === "user" || message.role === "assistant") && message.content.trim().length > 0) {
      seeds.push({ role: message.role, text: message.content, timestamp });
    }
  }
  for (const evidence of taskEvidence) {
    if (evidence.trim().length > 0) {
      seeds.push({ role: "user", text: evidence, timestamp });
    }
  }
  return seeds;
}

function progressKeyFor(predecessorId: string): string {
  return `predecessor-${predecessorId}`;
}

export async function recoverPiConversation(request: PiRecoveryRequest): Promise<PiRecoveryResult> {
  const now = request.now ?? Date.now;
  const timestamp = now();
  const taskEvidence = request.taskEvidence ?? [];
  const inspection = inspectOwnedConversationFile(
    request.sessionStorageRoot,
    request.predecessor.sessionDir,
    request.predecessor.conversationId,
    request.predecessor.sessionFile,
  );
  if (inspection.status === "intact") {
    return {
      status: "intact",
      successorId: request.predecessor.conversationId,
      successorDir: request.predecessor.sessionDir,
      seededCount: 0,
      archiveTotal: 0,
      currentInputAdmitted: true,
      taskEvidenceCount: 0,
      predecessorQuarantined: null,
      losses: [],
    };
  }
  if (inspection.status === "ambiguous") {
    throw new Error(`cannot reconstruct from an ambiguous predecessor file (${inspection.reason ?? "duplicate claimants"})`);
  }

  if (inspection.status === "corrupt" && inspection.canonicalFile === null) {
    throw new Error(`cannot reconstruct from an unavailable predecessor file (${inspection.reason ?? "no quarantinable file"})`);
  }

  const predecessorQuarantined = inspection.status === "corrupt" && inspection.canonicalFile !== null
    ? quarantineOwnedConversationFile(request.sessionStorageRoot, inspection.canonicalFile)
    : null;

  // Crash-safe same-successor resume: a retried reconstruction after
  // restart reuses the recorded successor instead of minting another.
  const progressKey = progressKeyFor(request.predecessor.conversationId);
  const recorded = loadPiReseedProgress(request.progressDir, progressKey);
  const successorId = typeof recorded.successorId === "string" && recorded.successorId.length > 0
    ? recorded.successorId
    : mintPiConversationId();
  if (recorded.successorId !== successorId) {
    savePiReseedProgress(request.progressDir, progressKey, { ...recorded, successorId });
  }

  const created = request.sessionManager.create(
    request.predecessor.cwd,
    request.predecessor.sessionDir,
    { id: successorId },
  );
  if (created.getSessionId() !== successorId) {
    throw new Error("Pi session id does not match the allocated successor id");
  }
  const writer = seedWriterForSessionManager({
    appendMessage: (message) => created.appendMessage(message),
  });

  const projected = await request.archiveSource.projectArchive(request.archive);
  const seeds = toSeedMessages(projected.messages, taskEvidence, timestamp);
  const progressStore = {
    loadProgress: () => loadPiReseedProgress(request.progressDir, progressKey),
    saveProgress: (_conversationId: string, progress: { seeded: number; currentAdmitted: boolean }) => {
      savePiReseedProgress(request.progressDir, progressKey, { ...progress, successorId });
    },
  };
  const report = reconstructPiConversation(
    writer,
    progressStore,
    successorId,
    seeds,
    request.current,
    () => progressStore.loadProgress().currentAdmitted,
    () => {
      const progress = progressStore.loadProgress();
      if (!progress.currentAdmitted) {
        progressStore.saveProgress(successorId, { ...progress, currentAdmitted: true });
      }
    },
  );

  return {
    ...report,
    status: "reconstructed",
    successorId,
    successorDir: request.predecessor.sessionDir,
    taskEvidenceCount: taskEvidence.filter((evidence) => evidence.trim().length > 0).length,
    predecessorQuarantined,
  };
}
