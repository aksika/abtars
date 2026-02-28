import { execSync } from "node:child_process";
import type { IKiroTransport } from "./kiro-transport.js";
import { logInfo, logDebug } from "./logger.js";

// Kiro CLI prompt pattern: "N% >" or "N% !>" where N is a number (context usage percentage)
// The "!" appears in trust-all-tools mode
const KIRO_PROMPT_RE = /^\d+%\s*!?>/;

// Also match common shell prompts as fallback
const SHELL_PROMPT_RE = /[$❯%#]\s*$/;

// Patterns that indicate Kiro is still working (don't treat stable output as "done")
const STILL_WORKING_RE = /WARNING:\s*Retry|retrying within|using tool:|Searching|Fetching content|Reading file|Running command|Executing/i;

/**
 * Communicates with kiro-cli running inside a tmux session.
 * Uses `tmux send-keys` to send prompts and `tmux capture-pane`
 * to read responses.
 */
export class TmuxClient implements IKiroTransport {
  private readonly sessionName: string;
  private readonly captureDelaySec: number;
  private readonly maxWaitSec: number;
  private ready = false;

  constructor(sessionName: string, captureDelaySec: number, maxWaitSec: number) {
    this.sessionName = sessionName;
    this.captureDelaySec = captureDelaySec;
    this.maxWaitSec = maxWaitSec;
  }

  async initialize(): Promise<void> {
    if (!this.sessionExists()) {
      throw new Error(
        `tmux session "${this.sessionName}" not found. ` +
        `Run: scripts/tmux-session.sh to start it.`,
      );
    }
    this.ready = true;
    logInfo("tmux", `Session "${this.sessionName}" found`);
  }

  get isReady(): boolean {
    return this.ready && this.sessionExists();
  }

  async sendPrompt(_sessionKey: string, message: string): Promise<string> {
    if (!this.isReady) {
      throw new Error("tmux session not available");
    }

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Snapshot pane content before sending
      const before = this.capturePaneRaw();
      if (attempt === 1) {
        logDebug("tmux", `Sending: "${message.slice(0, 80)}"`);
      } else {
        logInfo("tmux", `Retry #${attempt}: resending prompt`);
      }

      // Send the message
      const escaped = message.replace(/'/g, "'\\''");
      this.exec(`tmux send-keys -t ${this.sessionName} '${escaped}' Enter`);

      // Wait for initial processing
      await sleep(this.captureDelaySec * 1000);

      // Poll until Kiro finishes
      const response = await this.pollForResponse(before);

      // Check for Kiro transient error — retry once
      if (response.startsWith("Kiro is having trouble") && attempt < maxAttempts) {
        logInfo("tmux", `Kiro trouble detected, will retry in 5s...`);
        await sleep(5000);
        continue;
      }

      logDebug("tmux", `Got response (${response.length} chars)`);
      return response;
    }

    // Should not reach here, but just in case
    return "⚠️ Kiro is having trouble responding. Try again or /reset.";
  }

  async resetSession(_sessionKey: string): Promise<void> {
    if (!this.sessionExists()) return;
    this.exec(`tmux send-keys -t ${this.sessionName} C-c`);
    await sleep(1000);
    this.exec(`tmux send-keys -t ${this.sessionName} '/clear' Enter`);
    await sleep(2000);
    // Kiro asks "Are you sure? [y/n]:" — confirm with 'y'
    this.exec(`tmux send-keys -t ${this.sessionName} 'y' Enter`);
    await sleep(1000);
  }

  async sendInterrupt(): Promise<void> {
    if (!this.sessionExists()) return;
    logInfo("tmux", "Sending Ctrl+C interrupt");
    this.exec(`tmux send-keys -t ${this.sessionName} C-c`);
  }

  destroy(): void {
    this.ready = false;
  }

  /**
   * Poll capture-pane until Kiro's prompt reappears (meaning it's done),
   * or until output stabilizes, or timeout.
   */
  private async pollForResponse(beforeSnapshot: string): Promise<string> {
    const startTime = Date.now();
    const maxWaitMs = this.maxWaitSec * 1000;
    let lastCapture = "";
    let stableCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      const capture = this.capturePaneRaw();

      // Get only the NEW content (diff from before)
      const newContent = this.diffOutput(beforeSnapshot, capture);

      if (newContent.length === 0) {
        await sleep(2000);
        continue;
      }

      // Check if the last non-empty line is a Kiro prompt (N% >)
      const lines = capture.split("\n");
      const lastNonEmpty = this.getLastNonEmptyLine(lines);

      if (KIRO_PROMPT_RE.test(lastNonEmpty)) {
        // Kiro is back at its prompt — it's done
        logDebug("tmux", `Detected Kiro prompt: "${lastNonEmpty}"`);
        return this.extractResponse(newContent);
      }

      // Check for shell prompt as fallback
      if (SHELL_PROMPT_RE.test(lastNonEmpty) && newContent.length > 10) {
        logDebug("tmux", `Detected shell prompt: "${lastNonEmpty}"`);
        return this.extractResponse(newContent);
      }

      // Check if output has stabilized — but NOT if Kiro looks like it's still working
      if (capture === lastCapture) {
        stableCount++;
        const looksStillWorking = STILL_WORKING_RE.test(newContent);
        // Require 5 stable polls (10s) normally, or 15 (30s) if retry/tool patterns detected
        const threshold = looksStillWorking ? 15 : 5;
        if (stableCount >= threshold) {
          logDebug("tmux", `Output stabilized after ${stableCount} polls${looksStillWorking ? " (was retrying)" : ""}`);
          return this.extractResponse(newContent);
        }
      } else {
        stableCount = 0;
        lastCapture = capture;
      }

      await sleep(2000);
    }

    // Timeout
    const finalCapture = this.capturePaneRaw();
    const finalNew = this.diffOutput(beforeSnapshot, finalCapture);
    if (finalNew.length > 0) {
      return this.extractResponse(finalNew) + "\n\n⏱️ (response may be incomplete — timed out)";
    }
    return "⏱️ Kiro is still processing. Check the tmux session directly.";
  }

  /**
   * Extract the meaningful response from the diff.
   * Removes the echoed user input line and Kiro's prompt lines.
   * Stores the "answer only" portion (lines that were "> " prefixed)
   * separately for TTS use.
   *
   * Kiro output format:
   *   N% > <echoed user input>
   *   > <response line 1>
   *   > <response line 2>
   *   ▸ Time: Ns
   *   M% >
   */
  private lastAnswerOnly = "";

  /** Get just the Kiro answer lines ("> " prefixed) from the last response — for TTS. */
  get answerOnly(): string {
    return this.lastAnswerOnly;
  }

  private extractResponse(raw: string): string {
    const cleaned = this.stripAnsi(raw);

    const lines = cleaned.split("\n");
    const result: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines at start
      if (result.length === 0 && trimmed === "") continue;
      // Skip Kiro prompt lines (N% > ...) — these include echoed input
      if (KIRO_PROMPT_RE.test(trimmed)) continue;
      // Skip the "▸ Time:" summary line
      if (trimmed.startsWith("▸ Time:") || trimmed.startsWith("▸ Time:")) continue;
      // Skip separator lines
      if (/^-{4,}$/.test(trimmed)) continue;

      result.push(line);
    }

    // Find the LAST "> " block start — that's where the real answer begins.
    // Kiro output has multiple "> " sections; early ones are tool preamble,
    // the last one (typically after "Thinking...") is the actual response.
    let lastBlockStart = -1;
    for (let i = result.length - 1; i >= 0; i--) {
      const trimmed = result[i]!.trim();
      if (trimmed.startsWith("> ") && !trimmed.startsWith("> <br")) {
        lastBlockStart = i;
        break;
      }
    }

    // Extract answer-only: from last "> " block to end, stripping "> " prefixes
    if (lastBlockStart >= 0) {
      const answerSlice = result.slice(lastBlockStart);
      const answerStripped = answerSlice.map((line) => {
        const t = line.trimStart();
        if (t.startsWith("> ")) return t.slice(2);
        if (t === ">") return "";
        return line;
      });
      this.lastAnswerOnly = answerStripped.join("\n").trim();
    } else {
      this.lastAnswerOnly = "";
    }

    // Strip leading "> " from all Kiro response lines for the full text
    const stripped = result.map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("> ")) return trimmed.slice(2);
      if (trimmed === ">") return "";
      return line;
    });

    const final = stripped.join("\n").trim();
    logDebug("tmux", `extractResponse: ${result.length} lines → "${final.slice(0, 120)}"`);
    if (this.lastAnswerOnly && this.lastAnswerOnly !== final) {
      logDebug("tmux", `answerOnly (${this.lastAnswerOnly.length} chars): "${this.lastAnswerOnly.slice(0, 120)}"`);
    }
    return final;
  }

  /** Get new content by diffing before/after snapshots. */
  private diffOutput(before: string, after: string): string {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");

    // Find where the new content starts
    let commonPrefix = 0;
    while (
      commonPrefix < beforeLines.length &&
      commonPrefix < afterLines.length &&
      beforeLines[commonPrefix] === afterLines[commonPrefix]
    ) {
      commonPrefix++;
    }

    return afterLines.slice(commonPrefix).join("\n").trim();
  }

  /** Get the last non-empty line from an array. */
  private getLastNonEmptyLine(lines: string[]): string {
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]!.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return "";
  }

  /** Strip ANSI escape codes. */
  private stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
               .replace(/\x1B\][^\x07]*\x07/g, ""); // OSC sequences
  }

  private capturePaneRaw(): string {
    try {
      return this.exec(`tmux capture-pane -t ${this.sessionName} -p -S -2000`);
    } catch {
      return "";
    }
  }

  private sessionExists(): boolean {
    try {
      this.exec(`tmux has-session -t ${this.sessionName}`);
      return true;
    } catch {
      return false;
    }
  }

  private exec(command: string): string {
    return execSync(command, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
