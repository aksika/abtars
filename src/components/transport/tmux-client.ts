import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IKiroTransport } from "./kiro-transport.js";
import { logInfo, logDebug, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { abtarsHome } from "../../paths.js";

const TAG = "tmux";

// Kiro CLI prompt pattern: "N% >" or "N% !>" where N is a number (context usage percentage)
// The "!" appears in trust-all-tools mode
const KIRO_PROMPT_RE = /^\d+%\s*!?>/;

// Also match common shell prompts as fallback
const SHELL_PROMPT_RE = /[$❯%#]\s*$/;

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

  /** Optional callback for streaming intermediate responses before final prompt. */
  onIntermediateResponse?: (text: string) => void;

  /** Tracks the cumulative text delivered via intermediate chunks (for tail detection). */
  private lastIntermediateDelivered = "";

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

  readonly transportCommands: string[] = [];

  async sendPrompt(_sessionKey: string, message: string): Promise<string> {
    if (!this.isReady) {
      throw new Error("tmux session not available");
    }

    this.lastIntermediateDelivered = "";
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Snapshot pane content before sending
      const before = this.capturePaneRaw();
      if (attempt === 1) {
        logDebug("tmux", `Sending: "${message.slice(0, 80)}"`);
      } else {
        logInfo("tmux", `Retry #${attempt}: resending prompt`);
      }

      // Send the message — use temp file for long prompts to avoid tmux command length limit
      try {
        if (message.length > 4000) {
          const tmpDir = join(abtarsHome(), "tmp");
          mkdirSync(tmpDir, { recursive: true });
          const tmpFile = join(tmpDir, `prompt-${Date.now()}.txt`);
          writeFileSync(tmpFile, message);
          const readCmd = `My full message is in ${tmpFile} — please read it and respond.`;
          const escaped = readCmd.replace(/'/g, "'\\''");
          this.exec(`tmux send-keys -t ${this.sessionName} '${escaped}' Enter`);
          setTimeout(() => { try { unlinkSync(tmpFile); } catch (err) { logAndSwallow(TAG, "unlink tmpFile", err); } }, 120_000);
        } else {
          const escaped = message.replace(/'/g, "'\\''");
          this.exec(`tmux send-keys -t ${this.sessionName} '${escaped}' Enter`);
        }
      } catch (err) {
        logWarn("tmux", `send-keys failed: ${err instanceof Error ? err.message : String(err)}`);
        return "⚠️ Failed to send message to Kiro session. The tmux session may be in copy mode or unresponsive. Try /reset.";
      }

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

  async restartSession(workingDir: string, kiroModel?: string): Promise<void> {
    // Kill existing tmux session and start fresh
    if (this.sessionExists()) {
      this.exec(`tmux kill-session -t ${this.sessionName}`);
      await sleep(1000);
    }
    let cmd = `kiro-cli chat --trust-all-tools`;
    if (kiroModel) cmd += ` --model ${kiroModel}`;
    this.exec(`tmux new-session -d -s ${this.sessionName} -c '${workingDir}' '${cmd}'`);
    this.exec(`tmux set-option -t ${this.sessionName} history-limit 5000`);
    await sleep(3000);
    // Enable thinking tool
    this.exec(`tmux send-keys -t ${this.sessionName} '/settings chat.enableThinking true' Enter`);
    await sleep(2000);
    this.ready = this.sessionExists();
    logInfo("tmux", `Session restarted (ready=${this.ready})`);
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
   * Poll capture-pane until Kiro's prompt reappears (N% >).
   * Delivers intermediate purple-line responses via onIntermediateResponse callback
   * so the user sees partial answers while Kiro continues with tools.
   * Only returns when the actual Kiro prompt appears or timeout.
   */
  private async pollForResponse(beforeSnapshot: string): Promise<string> {
    const startTime = Date.now();
    const maxWaitMs = this.maxWaitSec * 1000;
    let lastCapture = "";
    let stableCount = 0;
    let lastDeliveredAnswer = "";

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
      const lastClean = this.stripAnsi(lastNonEmpty);

      if (KIRO_PROMPT_RE.test(lastClean)) {
        const pctMatch = lastClean.match(/^(\d+)%/);
        if (pctMatch) {
          this.lastContextPercent = parseInt(pctMatch[1]!, 10);
          logDebug("tmux", `Context window: ${this.lastContextPercent}%`);
        }
        logDebug("tmux", `Detected Kiro prompt: "${lastClean}"`);
        return this.extractResponse(newContent);
      }

      // Check for shell prompt as fallback
      if (SHELL_PROMPT_RE.test(lastClean) && newContent.length > 10) {
        logDebug("tmux", `Detected shell prompt: "${lastClean}"`);
        return this.extractResponse(newContent);
      }

      // No prompt yet — deliver intermediate answer if we have new purple lines
      if (this.onIntermediateResponse && capture !== lastCapture) {
        const intermediateAnswer = this.extractAnswerOnly(newContent);
        if (intermediateAnswer && intermediateAnswer !== lastDeliveredAnswer) {
          const newPart = intermediateAnswer.startsWith(lastDeliveredAnswer)
            ? intermediateAnswer.slice(lastDeliveredAnswer.length).trim()
            : intermediateAnswer;
          if (newPart) {
            logDebug("tmux", `Delivering intermediate chunk (${newPart.length} chars)`);
            this.onIntermediateResponse(newPart);
            lastDeliveredAnswer = intermediateAnswer;
            this.lastIntermediateDelivered = intermediateAnswer;
          }
        }
      }

      // Track stabilization but do NOT return on it — only N% > ends the poll
      if (capture === lastCapture) {
        stableCount++;
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
  private lastContextPercent = -1;

  /** Get just the Kiro answer lines ("> " prefixed) from the last response — for TTS. */
  get answerOnly(): string {
    return this.lastAnswerOnly;
  }
  get toolCallsSucceeded(): number { return 0; }

  /** Get the context window usage percentage from the last Kiro prompt (e.g. 10 for "10% >"). Returns -1 if unknown. */
  get contextPercent(): number {
    return this.lastContextPercent;
  }
  /** Get the cumulative text that was delivered via intermediate streaming. */
  get intermediateDeliveredText(): string {
    return this.lastIntermediateDelivered;
  }

  /** Extract just the purple "> " answer lines from raw tmux output (no side effects). */
  private extractAnswerOnly(raw: string): string {
    const PURPLE_PREFIX = /\x1b\[38;5;141m>\s/;
    const lines = raw.split("\n");

    // Find last contiguous block of purple lines
    let blockStart = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (PURPLE_PREFIX.test(lines[i]!)) {
        blockStart = i;
        while (blockStart > 0 && PURPLE_PREFIX.test(lines[blockStart - 1]!)) blockStart--;
        break;
      }
    }
    if (blockStart < 0) return "";

    const answerLines: string[] = [];
    for (let i = blockStart; i < lines.length; i++) {
      const clean = this.stripAnsi(lines[i]!).trim();
      if (KIRO_PROMPT_RE.test(clean)) break;
      if (clean.startsWith("▸ Time:")) break;
      if (clean.startsWith("> ")) answerLines.push(clean.slice(2));
      else if (clean === ">") answerLines.push("");
      else if (clean === "") answerLines.push("");
      else answerLines.push(clean);
    }
    return answerLines.join("\n").trim();
  }

  private extractResponse(raw: string): string {
    // ANSI color 141 (light purple) marks the "> " prefix on actual LLM response lines.
    // We detect these BEFORE stripping ANSI to reliably distinguish LLM output from
    // injected context (gray, color 245) and other noise.
    const PURPLE_PREFIX = /\x1b\[38;5;141m>\s/;

    const lines = raw.split("\n");

    // First pass: identify lines that are genuine LLM responses (purple "> " prefix)
    const answerLines: string[] = [];
    let lastPurpleBlockStart = -1;

    for (let i = 0; i < lines.length; i++) {
      if (PURPLE_PREFIX.test(lines[i]!)) {
        if (lastPurpleBlockStart === -1) lastPurpleBlockStart = i;
      }
    }

    // Find the LAST contiguous block of purple "> " lines — that's the real answer.
    // Walk backwards to find the start of the last block.
    let blockStart = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (PURPLE_PREFIX.test(lines[i]!)) {
        blockStart = i;
        // Keep walking back through contiguous purple lines and continuation lines
        while (blockStart > 0) {
          const prev = lines[blockStart - 1]!;
          if (PURPLE_PREFIX.test(prev) || (!KIRO_PROMPT_RE.test(this.stripAnsi(prev).trim()) && !prev.includes("▸ Time:") && this.stripAnsi(prev).trim() !== "" && !PURPLE_PREFIX.test(prev) && blockStart === i)) {
            // Only extend back through purple lines
            if (PURPLE_PREFIX.test(prev)) {
              blockStart--;
            } else {
              break;
            }
          } else {
            break;
          }
        }
        break;
      }
    }

    if (blockStart >= 0) {
      // Extract from the last purple block to the end, stripping ANSI and "> " prefix
      for (let i = blockStart; i < lines.length; i++) {
        const line = lines[i]!;
        const clean = this.stripAnsi(line).trim();
        // Stop at Kiro prompt or Time summary
        if (KIRO_PROMPT_RE.test(clean)) break;
        if (clean.startsWith("▸ Time:") || clean.startsWith("▸ Time:")) break;
        if (clean === "") {
          answerLines.push("");
          continue;
        }
        // Strip "> " prefix
        if (clean.startsWith("> ")) {
          answerLines.push(clean.slice(2));
        } else if (clean === ">") {
          answerLines.push("");
        } else {
          answerLines.push(clean);
        }
      }
      this.lastAnswerOnly = answerLines.join("\n").trim();
    } else {
      this.lastAnswerOnly = "";
    }

    // Full response: strip ANSI, then remove prompt lines and noise (legacy behavior)
    const cleaned = this.stripAnsi(raw);
    const allLines = cleaned.split("\n");
    const result: string[] = [];

    for (const line of allLines) {
      const trimmed = line.trim();
      if (result.length === 0 && trimmed === "") continue;
      if (KIRO_PROMPT_RE.test(trimmed)) continue;
      if (trimmed.startsWith("▸ Time:") || trimmed.startsWith("▸ Time:")) continue;
      if (/^-{4,}$/.test(trimmed)) continue;
      result.push(line);
    }

    const stripped = result.map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("> ")) return trimmed.slice(2);
      if (trimmed === ">") return "";
      return line;
    });

    const final = stripped.join("\n").trim();
    logDebug("tmux", `extractResponse: ${result.length} lines → "${final.slice(0, 120)}"`);
    if (this.lastAnswerOnly) {
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
      return this.exec(`tmux capture-pane -t ${this.sessionName} -p -e -S -2000`);
    } catch (err) {
      logAndSwallow(TAG, "capturePaneRaw", err);
      return "";
    }
  }

  private sessionExists(): boolean {
    try {
      this.exec(`tmux has-session -t ${this.sessionName}`);
      return true;
    } catch (err) {
      logAndSwallow(TAG, "sessionExists check", err);
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
