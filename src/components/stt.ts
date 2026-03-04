import { logInfo, logDebug } from "./logger.js";

export type SttProvider = "groq";

export interface SttConfig {
  provider: SttProvider;
  apiKey: string;
  model?: string;
}

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3";
export const LANGUAGE_HINT_PROMPT = "ez egy magyar szöveg. or English";

/**
 * Transcribe audio using Groq's OpenAI-compatible Whisper endpoint.
 * Sends the audio as multipart/form-data.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
  config: SttConfig,
): Promise<string> {
  const model = config.model || DEFAULT_MODEL;
  logInfo("stt", `Transcribing ${filename} (${audioBuffer.length} bytes) via ${config.provider}/${model}`);

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: "audio/ogg" });
  formData.append("file", blob, filename);
  formData.append("model", model);
  formData.append("prompt", LANGUAGE_HINT_PROMPT);

  const endpoint = GROQ_ENDPOINT;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`STT failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { text?: string };
  const transcript = json.text?.trim() ?? "";

  if (!transcript) {
    logDebug("stt", "Empty transcript returned");
    return "";
  }

  logInfo("stt", `Transcript (${transcript.length} chars): "${transcript.slice(0, 80)}"`);
  return transcript;
}
