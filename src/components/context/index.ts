// Re-export from abmind (orchestrator moved there in #432)
// ContextOrchestrator accessed via abmind() lazy loader at runtime
export type { ContextOrchestratorConfig, ContextResult, SummarizeFn } from "abmind";
export { createContextOrchestrator, createSummarizeFn } from "./context-bridge.js";
