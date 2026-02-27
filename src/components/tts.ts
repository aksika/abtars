import { EdgeTTS, Constants } from "@andresaya/edge-tts";
import { logInfo, logDebug, logWarn } from "./logger.js";

export interface TtsConfig {
  voice: string;
}

const MAX_TTS_CHARS = 4000;

/**
 * Synthesize text to OGG Opus audio buffer using Microsoft Edge TTS.
 * Returns null if synthesis fails or text is too short/empty.
 */
export async function synthesizeSpeech(
  text: string,
  config: TtsConfig,
): Promise<Buffer | null> {
  const cleaned = cleanForTts(text).trim();
  if (!cleaned || cleaned.length < 5) {
    logDebug("tts", `Text too short for TTS (${cleaned.length} chars)`);
    return null;
  }

  // Truncate very long responses
  const input = cleaned.length > MAX_TTS_CHARS
    ? cleaned.slice(0, MAX_TTS_CHARS) + "... (truncated)"
    : cleaned;

  logInfo("tts", `Synthesizing ${input.length} chars with voice ${config.voice}`);

  try {
    const tts = new EdgeTTS();
    await tts.synthesize(input, config.voice, {
      rate: "+0%",
      pitch: "+0Hz",
      outputFormat: Constants.OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS,
    });
    const audioBuffer = tts.toBuffer();

    if (!audioBuffer || audioBuffer.length === 0) {
      logWarn("tts", "Edge TTS returned empty audio");
      return null;
    }

    logInfo("tts", `Audio generated: ${audioBuffer.length} bytes`);
    return audioBuffer;
  } catch (err) {
    logWarn("tts", `TTS synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Strip reasoning, tool noise, HTML tags, and markdown for cleaner TTS output. */
function cleanForTts(text: string): string {
  return text
    // --- HTML tags ---
    .replace(/<br\s*\/?>/gi, "\n")                            // <br> → newline
    .replace(/<[^>]+>/g, "")                                  // strip all HTML tags
    // --- Kiro reasoning / tool noise (line-level) ---
    .replace(/^.*\(using tool:\s*\w+\).*$/gm, "")            // "... (using tool: web_search)"
    .replace(/^.*\[mode:.*$/gm, "")                           // "[mode:..." truncated tool lines
    .replace(/^(Fetching content from|Searching the web|Searching for|Reading file|Writing to|Running command|Executing|Looking at|Checking).*$/gm, "")
    .replace(/^(Let me|I'll|I will|I need to|I'm going to|I should)\b.*$/gm, "")
    .replace(/^- Completed in \d+(\.\d+)?s.*$/gm, "")        // "- Completed in 0.0s"
    .replace(/^WARNING:.*$/gm, "")                            // "WARNING: Retry #2, retrying within..."
    .replace(/^https?:\/\/\S+$/gm, "")                       // URL-only lines
    .replace(/^\s*\[.*?\]\s*$/gm, "")                        // [tool output] lines
    // --- Markdown ---
    .replace(/```[\s\S]*?```/g, " (code block omitted) ")    // code blocks
    .replace(/`[^`]+`/g, "")                                  // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")                 // links → text
    .replace(/[*_~]{1,3}/g, "")                               // bold/italic/strike
    .replace(/^#{1,6}\s+/gm, "")                              // headings
    .replace(/^[-*+]\s+/gm, "")                               // list markers
    .replace(/^\d+\.\s+/gm, "")                               // numbered lists
    // --- Cleanup ---
    .replace(/\n{3,}/g, "\n\n")                               // excess newlines
    .trim();
}
