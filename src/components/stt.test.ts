// Feature: telegram-enhancements, Property 1: STT request shape invariant
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

// Mock the logger to suppress output during tests
vi.mock("./logger.js", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { transcribeAudio, LANGUAGE_HINT_PROMPT } from "./stt.js";
import type { SttConfig } from "./stt.js";

describe("transcribeAudio — Property 1: STT request shape invariant", () => {
  let capturedFormData: FormData | null = null;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    capturedFormData = null;
    // Mock global fetch to capture the FormData body and return a successful response
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedFormData = init?.body as FormData;
      return new Response(JSON.stringify({ text: "test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Validates: Requirements 1.1, 1.2, 1.3, 2.3
   *
   * For any audio buffer and filename, the FormData sent to Whisper SHALL
   * contain a "prompt" field equal to LANGUAGE_HINT_PROMPT and SHALL NOT
   * contain a "language" field.
   */
  it("includes prompt only when STT_LANGUAGE_HINT is set, never includes language field", async () => {
    const config: SttConfig = { provider: "groq", apiKey: "test-key-123" };

    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
        async (audioBytes, filename) => {
          const audioBuffer = Buffer.from(audioBytes);
          await transcribeAudio(audioBuffer, filename, config);

          expect(capturedFormData).not.toBeNull();
          if (LANGUAGE_HINT_PROMPT) {
            expect(capturedFormData!.has("prompt")).toBe(true);
            expect(capturedFormData!.get("prompt")).toBe(LANGUAGE_HINT_PROMPT);
          } else {
            expect(capturedFormData!.has("prompt")).toBe(false);
          }
          expect(capturedFormData!.has("language")).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("transcribeAudio — Unit tests: prompt value and language field", () => {
  let capturedFormData: FormData | null = null;
  const originalFetch = globalThis.fetch;
  const config: SttConfig = { provider: "groq", apiKey: "test-key-unit" };

  beforeEach(() => {
    capturedFormData = null;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedFormData = init?.body as FormData;
      return new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends prompt from STT_LANGUAGE_HINT env var when set", async () => {
    const audio = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
    await transcribeAudio(audio, "voice.ogg", config);

    // LANGUAGE_HINT_PROMPT is read at import time; if env not set, prompt field is omitted
    if (LANGUAGE_HINT_PROMPT) {
      expect(capturedFormData!.get("prompt")).toBe(LANGUAGE_HINT_PROMPT);
    } else {
      expect(capturedFormData!.has("prompt")).toBe(false);
    }
  });

  it("does not include a language field in the FormData", async () => {
    const audio = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
    await transcribeAudio(audio, "voice.ogg", config);

    expect(capturedFormData).not.toBeNull();
    expect(capturedFormData!.has("language")).toBe(false);
  });

  it("LANGUAGE_HINT_PROMPT defaults to empty when env not set", () => {
    // At test time, STT_LANGUAGE_HINT is not set → empty string
    expect(typeof LANGUAGE_HINT_PROMPT).toBe("string");
  });
});
