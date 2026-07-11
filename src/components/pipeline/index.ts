/**
 * Pipeline assembly — the ordered middleware chain.
 *
 * Adding a new behavior = adding a middleware to this list.
 * Each middleware calls next() to continue or sets ctx.handled to stop.
 */

export { type MessageContext, type Middleware, runPipeline, createMessageContext } from "./middleware.js";
export { voiceMiddleware } from "./voice.js";
export { commandMiddleware } from "./commands.js";
export { pausedGuardMiddleware } from "./paused-guard.js";
export { busyGuardMiddleware } from "./busy-guard.js";
export { buildPrompt, type BuildPromptDeps, type BuildPromptResult } from "./prompt-builder.js";
