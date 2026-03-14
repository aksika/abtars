#!/usr/bin/env node
/**
 * agentbridge-browser — standalone CLI for agent-initiated browser control.
 *
 * Gives the LLM agent direct control over a headless Chromium browser.
 * Follows the same pattern as agentbridge-recall and agentbridge-store.
 *
 * Usage:
 *   agentbridge-browser --action navigate --url "https://example.com" --session-id default
 *   agentbridge-browser --action fill --selector "#email" --value "user@example.com" --session-id auth
 *   agentbridge-browser --action click --selector "text=Sign In" --session-id auth
 *   agentbridge-browser --action extract_text --session-id auth
 *   agentbridge-browser --action screenshot --full-page --session-id auth
 *   agentbridge-browser --action get_page_info --session-id auth
 *   agentbridge-browser --action close_session --session-id auth
 *
 * Output (success):
 *   { "success": true, "title": "Example", "url": "https://example.com", "status": 200 }
 *
 * Output (error):
 *   { "success": false, "error": "navigate action requires --url" }
 */

import type { BrowserAction, BrowserActionType } from "../types/browser.js";
import { BrowserManager } from "../components/browser-manager.js";
import { BrowserTool } from "../components/browser-tool.js";
import { DomainAllowlist } from "../components/domain-allowlist.js";

/** The 7 valid browser action types. */
const VALID_ACTIONS: ReadonlySet<string> = new Set<BrowserActionType>([
  "navigate",
  "click",
  "fill",
  "extract_text",
  "screenshot",
  "get_page_info",
  "close_session",
]);

export type RawBrowserArgs = {
  action?: string;
  url?: string;
  selector?: string;
  value?: string;
  sessionId: string;
  fullPage: boolean;
};

/**
 * Parse raw CLI argv into a RawBrowserArgs object.
 * Exported for unit testing.
 */
export function parseArgs(argv: string[]): RawBrowserArgs {
  const args = argv.slice(2);
  const parsed: RawBrowserArgs = { sessionId: "default", fullPage: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--action":     parsed.action = args[++i] ?? ""; break;
      case "--url":        parsed.url = args[++i] ?? ""; break;
      case "--selector":   parsed.selector = args[++i] ?? ""; break;
      case "--value":      parsed.value = args[++i] ?? ""; break;
      case "--session-id": parsed.sessionId = args[++i] ?? "default"; break;
      case "--full-page":  parsed.fullPage = true; break;
    }
  }

  return parsed;
}

/**
 * Validate raw CLI arguments and return either a parsed BrowserAction or an error string.
 * Exported for unit testing.
 */
export function validateArgs(
  raw: RawBrowserArgs,
): { ok: true; action: BrowserAction } | { ok: false; error: string } {
  // Validate action is one of the 7 valid types
  if (!raw.action) {
    return { ok: false, error: "--action is required" };
  }
  if (!VALID_ACTIONS.has(raw.action)) {
    return {
      ok: false,
      error: `Invalid action "${raw.action}". Valid actions: ${[...VALID_ACTIONS].join(", ")}`,
    };
  }

  const actionType = raw.action as BrowserActionType;

  // Validate required params per action
  switch (actionType) {
    case "navigate":
      if (!raw.url) return { ok: false, error: "navigate action requires --url" };
      break;
    case "click":
      if (!raw.selector) return { ok: false, error: "click action requires --selector" };
      break;
    case "fill":
      if (!raw.selector) return { ok: false, error: "fill action requires --selector" };
      if (raw.value === undefined) return { ok: false, error: "fill action requires --value" };
      break;
    // extract_text, screenshot, get_page_info, close_session have no extra required params
  }

  return {
    ok: true,
    action: {
      action: actionType,
      sessionId: raw.sessionId,
      url: raw.url,
      selector: raw.selector,
      value: raw.value,
      fullPage: raw.fullPage,
    },
  };
}

// --- CLI entry point (only runs when executed directly) ---

async function main() {
  const raw = parseArgs(process.argv);
  const validation = validateArgs(raw);

  if (!validation.ok) {
    console.log(JSON.stringify({ success: false, error: validation.error }));
    process.exit(1);
  }

  // Try IPC to main process BrowserManager via Unix domain socket;
  // fall back to ephemeral browser if main process not running.
  let browserManager: BrowserManager;
  let isEphemeral = false;

  // For now, always use an ephemeral BrowserManager.
  // IPC via ~/.agentbridge/browser.sock can be added when the main process
  // exposes a socket server.
  browserManager = new BrowserManager();
  isEphemeral = true;

  const allowlist = DomainAllowlist.fromEnv();
  const tool = new BrowserTool(browserManager, allowlist);

  try {
    const result = await tool.execute(validation.action);
    console.log(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ success: false, error: message }));
  } finally {
    if (isEphemeral) {
      await browserManager.shutdown();
    }
  }
}

// Only run when executed as a script, not when imported for testing
const isDirectRun =
  process.argv[1]?.endsWith("agentbridge-browser.ts") ||
  process.argv[1]?.endsWith("agentbridge-browser.js");
if (isDirectRun) {
  main();
}
