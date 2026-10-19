import {
  allocatePiSuccessor,
  type PiConversationBinding,
} from "./pi-conversation-identity.js";
import {
  findRecoverySuccessor,
  inspectOwnedConversationFile,
  loadPiReseedProgress,
  markPiConversationEnded,
  openPiConversation,
  quarantineOwnedConversationFile,
  savePiReseedProgress,
  seedWriterForSessionManager,
  type PiConversationHandle,
  type PiSessionManagerCtor,
} from "./pi-session-adapter.js";
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
 * losses and ambiguous work is never replayed. Crash-safe: registry-backed
 * seed/current-input progress lets a retry resume the same successor.
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

export interface PiRecoveryRequest {
  manager: PiSessionManagerCtor;
  stateRoot: string;
  predecessor: PiConversationBinding;
  archive: PiRecoveryArchiveQuery;
  archiveSource: PiRecoveryArchiveSource;
  current: PiRecoveryCurrentInput;
  /** Durable task/project snapshot lines to preserve as user history. */
  taskEvidence?: readonly string[];
  retirePredecessor?: boolean;
  now?: () => number;
}

export interface PiRecoveryResult extends PiReconstructionReport {
  status: "intact" | "reconstructed";
  handle: PiConversationHandle;
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

export async function recoverPiConversation(request: PiRecoveryRequest): Promise<PiRecoveryResult> {
  const now = request.now ?? Date.now;
  const timestamp = now();
  const taskEvidence = request.taskEvidence ?? [];
  const inspection = inspectOwnedConversationFile(request.manager, request.stateRoot, request.predecessor);
  if (inspection.status === "intact") {
    const handle = openPiConversation(request.manager, request.stateRoot, request.predecessor);
    return {
      status: "intact",
      handle,
      successorId: handle.binding.conversationId,
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
    ? quarantineOwnedConversationFile(request.stateRoot, request.predecessor, inspection.canonicalFile)
    : null;

  const successor = findRecoverySuccessor(request.stateRoot, request.predecessor)
    ?? allocatePiSuccessor(request.predecessor);
  const handle = openPiConversation(request.manager, request.stateRoot, successor);
  const appendMessage = handle.session.appendMessage;
  if (typeof appendMessage !== "function") {
    throw new Error("Pi session manager cannot accept seeded history");
  }
  const writer = seedWriterForSessionManager({
    appendMessage: (message) => appendMessage.call(handle.session, message),
  });

  const projected = await request.archiveSource.projectArchive(request.archive);
  const seeds = toSeedMessages(projected.messages, taskEvidence, timestamp);
  const progressStore = {
    loadProgress: () => loadPiReseedProgress(request.stateRoot, successor.conversationId),
    saveProgress: (_conversationId: string, progress: { seeded: number; currentAdmitted: boolean }) => {
      savePiReseedProgress(request.stateRoot, successor.conversationId, progress);
    },
  };
  const report = reconstructPiConversation(
    writer,
    progressStore,
    successor.conversationId,
    seeds,
    request.current,
    () => progressStore.loadProgress().currentAdmitted,
    () => {
      const progress = progressStore.loadProgress();
      if (!progress.currentAdmitted) {
        progressStore.saveProgress(successor.conversationId, { ...progress, currentAdmitted: true });
      }
    },
  );

  if (request.retirePredecessor ?? true) {
    markPiConversationEnded(request.stateRoot, request.predecessor.conversationId, timestamp);
  }

  return {
    ...report,
    status: "reconstructed",
    handle,
    taskEvidenceCount: taskEvidence.filter((evidence) => evidence.trim().length > 0).length,
    predecessorQuarantined,
  };
}
