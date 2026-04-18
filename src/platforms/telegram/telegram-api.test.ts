import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramApi } from "./telegram-api.js";

describe("TelegramApi.sendDocument", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const tmpFile = join(tmpdir(), "telegram-api-senddoc.md");

  beforeEach(() => {
    writeFileSync(tmpFile, "# hello\n\nreport body", "utf-8");
    fetchSpy.mockReset();
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("POSTs multipart to /sendDocument and returns message_id", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    } as unknown as Response);

    const api = new TelegramApi("test-token");
    const id = await api.sendDocument(123, tmpFile, "my caption");

    expect(id).toBe(42);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/bottest-token/sendDocument");
    expect((init as RequestInit).method).toBe("POST");
    const form = (init as RequestInit).body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chat_id")).toBe("123");
    expect(form.get("caption")).toBe("my caption");
    expect(form.get("document")).toBeInstanceOf(Blob);
  });

  it("truncates caption to 1024 chars", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    } as unknown as Response);

    const long = "x".repeat(2000);
    const api = new TelegramApi("t");
    await api.sendDocument(1, tmpFile, long);

    const form = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(String(form.get("caption")).length).toBe(1024);
  });

  it("throws on non-OK response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request: file too large",
    } as unknown as Response);

    const api = new TelegramApi("t");
    await expect(api.sendDocument(1, tmpFile)).rejects.toThrow(/sendDocument failed \(400\)/);
  });

  it("omits caption field when not provided", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    } as unknown as Response);

    const api = new TelegramApi("t");
    await api.sendDocument(1, tmpFile);

    const form = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.has("caption")).toBe(false);
  });
});
