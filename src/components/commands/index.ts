/**
 * Unified command handlers for all platforms (Telegram, Discord).
 * Split from the original monolithic command-handlers.ts.
 */

export type { Reply, CommandContext, CommandHandler, Platform } from "./types.js";
export { registerCommand, handleCommand, triggerNewSession, triggerResetSession, killWakeInhibit } from "./registry.js";
import { registerExact, registerPrefix } from "./registry.js";
import {
  handleNewReset, handleCompact,
  handleStatus, handleDoctor, handleStop, handleWait, handleRestart,
  handleFull, handleShort, handleHealing, handleFacts,
  handleTasksList, handleTasksTrigger, handleTasksLog, handleTaskPause,
  handleEmergencyAlias, handleModels, handleHeartbeat,
  handleMemory, handleNlm, handleWakeup,
  handleSleep, handleSleepSub, handleHelp, handleSkills,
  handleHooks, handleMcp, handleUsers, handleUsage, handleOpenRouter,
} from "./handlers.js";
import { handleSession } from "./session-handler.js";

// ── Exact-match commands ────────────────────────────────────────────────────
registerExact("/reset", handleNewReset);
registerExact("/compact", handleCompact);
registerExact("/status", handleStatus);
registerExact("/doctor", handleDoctor);
registerExact("/stop", handleStop);
registerExact("/ctrlc", handleStop);
registerExact("/wait", handleWait);
registerExact("/steer", handleWait);
registerExact("/restart", handleRestart);
registerExact("/full", handleFull);
registerExact("/short", handleShort);
registerExact("/healing", handleHealing);
registerExact("/facts", handleFacts);
registerExact("/tasks", handleTasksList);
registerExact("/task", handleTasksList);
registerExact("/cron", handleTasksList);
registerExact("/memory", handleMemory);
registerExact("/heartbeat", handleHeartbeat);
registerExact("/models", handleModels);
registerExact("/model", handleModels);
registerExact("/change", (_, ctx) => handleModels("/model change", ctx));
registerExact("/emergency", handleEmergencyAlias);
registerExact("/help", handleHelp);
registerExact("/users", handleUsers);
registerExact("/skills", handleSkills);
registerExact("/skill", handleSkills);
registerExact("/wakeup", handleWakeup);
registerExact("/sleep", handleSleep);
registerExact("/mcp", handleMcp);
registerExact("/hooks", handleHooks);
registerExact("/usage", handleUsage);
registerExact("/openrouter", handleOpenRouter);
registerExact("/session", handleSession);

// ── Prefix-match commands ───────────────────────────────────────────────────
registerPrefix("/session ", handleSession);
registerPrefix("/tasks run ", handleTasksTrigger);
registerPrefix("/task run ", handleTasksTrigger);
registerPrefix("/cron run ", handleTasksTrigger);
registerPrefix("/tasks log ", handleTasksLog);
registerPrefix("/task log ", handleTasksLog);
registerPrefix("/cron log ", handleTasksLog);
registerPrefix("/nlm", handleNlm);
registerPrefix("/sleep ", handleSleepSub);
registerPrefix("/usage ", handleUsage);
registerPrefix("/task pause ", handleTaskPause);
registerPrefix("/task resume ", handleTaskPause);
registerPrefix("/tasks pause ", handleTaskPause);
registerPrefix("/tasks resume ", handleTaskPause);
