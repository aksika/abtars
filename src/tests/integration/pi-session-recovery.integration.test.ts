/**
 * Live R5 integration: a corrupt Pi-owned session file is rebuilt from the
 * real abmind archive and current input through the production recovery path.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbmindClient,
  AbmindService,
  LocalEndpointServer,
  LocalTransport,
  MemoryManager,
  MEMORY_CONFIG_DEFAULTS,
  type MemoryConfig,
} from "abmind";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createClientRuntime, type AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import { mintPiConversationId, resolvePiConversationDir } from "../../components/pi-session/pi-conversation-identity.js";
import { readPiSessionHeaderId } from "../../components/pi-session/pi-owned-files.js";
import { recoverPiConversation } from "../../components/pi-session/pi-session-recovery.js";

const USER_ID = "local-user";
const ARCHIVE_SESSION = "recovery-archive";

describe("live Pi conversation recovery (R5)", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  let service: AbmindService;
  let endpoint: LocalEndpointServer;
  let transport: LocalTransport;
  let client: AbmindClient;
  let runtime: AbtarsMemoryRuntime;
  let savedOwner: string | undefined;

  beforeAll(async () => {
    savedOwner = process.env["ABMIND_USER_ID"];
    process.env["ABMIND_USER_ID"] = USER_ID;
    tmpDir = mkdtempSync(join(tmpdir(), "abtars-pi-recovery-"));
    const config: MemoryConfig = { ...MEMORY_CONFIG_DEFAULTS, memoryDir: join(tmpDir, "memory") };
    manager = new MemoryManager(config);
    await manager.initialize();
    const db = (manager as unknown as { db: unknown }).db;
    if (!db) throw new Error("memory database not initialized");

    service = new AbmindService({
      serverInstanceId: "pi-recovery",
      mode: "daemon",
      manager,
      operational: null,
      requestLedgerDb: db,
    });
    const socketPath = join(tmpDir, "memory.sock");
    endpoint = new LocalEndpointServer({ socketPath, service, principalMapping: "self" });
    await endpoint.start();
    transport = new LocalTransport(socketPath);
    client = new AbmindClient(transport);
    await client.negotiate();
    runtime = createClientRuntime(client);
  });

  afterAll(async () => {
    await client.close();
    await endpoint.stop();
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedOwner === undefined) delete process.env["ABMIND_USER_ID"];
    else process.env["ABMIND_USER_ID"] = savedOwner;
  });

  it("reconstructs a corrupt owned file from the live archive and current input", async () => {
    const first = await runtime.recordMessage({
      role: "user",
      content: "PI-RECOVERY-FIRST",
      timestamp: 1,
      userId: USER_ID,
      sessionId: ARCHIVE_SESSION,
    }, "recovery-first");
    const second = await runtime.recordMessage({
      role: "assistant",
      content: "PI-RECOVERY-SECOND",
      timestamp: 2,
      userId: USER_ID,
      sessionId: ARCHIVE_SESSION,
    }, "recovery-second");
    const current = await runtime.recordMessage({
      role: "user",
      content: "PI-RECOVERY-CURRENT",
      timestamp: 3,
      userId: USER_ID,
      sessionId: ARCHIVE_SESSION,
    }, "recovery-current");
    if (typeof first.id !== "number" || typeof second.id !== "number" || typeof current.id !== "number") {
      throw new Error("live archive rows were not durably confirmed");
    }

    const stateRoot = mkdtempSync(join(tmpDir, "pi-recovery-state-"));
    const workspace = mkdtempSync(join(tmpDir, "pi-recovery-workspace-"));
    const progressDir = mkdtempSync(join(tmpDir, "pi-recovery-progress-"));
    const predecessorId = mintPiConversationId();
    const predecessorDir = resolvePiConversationDir(stateRoot, USER_ID, "worker", workspace);
    const predecessor = { conversationId: predecessorId, sessionDir: predecessorDir, cwd: workspace };
    const direct = SessionManager.create(workspace, predecessorDir, { id: predecessorId });
    if (typeof direct.appendMessage !== "function") {
      throw new Error("real Pi session cannot accept seeded history");
    }
    direct.appendMessage({
      role: "user",
      content: [{ type: "text", text: "predecessor history" }],
      timestamp: Date.now(),
    });
    const predecessorFile = direct.getSessionFile();
    if (!predecessorFile) throw new Error("real Pi session did not flush history");
    writeFileSync(predecessorFile, "corrupt\n");

    const result = await recoverPiConversation({
      sessionManager: SessionManager as never,
      sessionStorageRoot: stateRoot,
      progressDir,
      predecessor,
      archive: {
        userId: USER_ID,
        archiveSessionId: ARCHIVE_SESSION,
        beforeMessageId: current.id,
        maxContext: 100_000,
      },
      archiveSource: {
        projectArchive: (input) => runtime.projectDurableContext({
          userId: input.userId,
          sessionId: input.archiveSessionId,
          beforeMessageId: input.beforeMessageId,
          maxContext: input.maxContext,
        }),
      },
      current: { text: "PI-RECOVERY-CURRENT", timestamp: 3, operationKey: "recovery-current-input" },
      taskEvidence: ["durable task evidence"],
      now: () => 4,
    });

    expect(result.status).toBe("reconstructed");
    expect(result.successorId).not.toBe(predecessor.conversationId);
    expect(result.successorDir).toBe(predecessor.sessionDir);
    expect(result.predecessorQuarantined ?? "").toMatch(new RegExp(`^${predecessorFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.quarantined-`));
    expect(existsSync(predecessorFile)).toBe(false);
    expect(result.archiveTotal).toBe(3);
    expect(result.taskEvidenceCount).toBe(1);
    expect(result.currentInputAdmitted).toBe(true);
    expect(result.losses).toContain("branch structure");
    // The successor session flushed seeded history under its own ID.
    const successorFiles = readdirSync(predecessor.sessionDir).filter((name) => name.endsWith(".jsonl"));
    const successorFile = successorFiles
      .map((name) => join(predecessor.sessionDir, name))
      .find((file) => readPiSessionHeaderId(file) === result.successorId && !file.startsWith(`${predecessorFile}.quarantined`));
    if (!successorFile) throw new Error("reconstructed Pi session did not flush history");
    const successorText = readFileSync(successorFile, "utf-8");
    for (const marker of ["PI-RECOVERY-FIRST", "PI-RECOVERY-SECOND", "durable task evidence", "PI-RECOVERY-CURRENT"]) {
      expect(successorText).toContain(marker);
    }
  });
});
