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

describe("TelegramApi.fetchWithRetry (retry paths)", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const tmpFile = join(tmpdir(), "telegram-api-retry.md");

  beforeEach(() => {
    writeFileSync(tmpFile, "# hello", "utf-8");
    fetchSpy.mockReset();
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("sendVoice: retries on 502 and succeeds on attempt 2", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => "bad gateway" } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) } as unknown as Response);

    const api = new TelegramApi("t");
    const id = await api.sendVoice(1, Buffer.from("audio"));

    expect(id).toBe(7);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Each attempt must build a fresh FormData (factory pattern)
    const body1 = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    const body2 = (fetchSpy.mock.calls[1]![1] as RequestInit).body as FormData;
    expect(body1).not.toBe(body2);
  }, 15_000);

  it("sendDocument: retries on ECONNRESET and succeeds on attempt 3", async () => {
    const econnreset = Object.assign(new Error("socket hang up ECONNRESET"), { code: "ECONNRESET" });
    fetchSpy
      .mockRejectedValueOnce(econnreset)
      .mockRejectedValueOnce(econnreset)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) } as unknown as Response);

    const api = new TelegramApi("t");
    const id = await api.sendDocument(1, tmpFile);

    expect(id).toBe(99);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 20_000);

  it("downloadFile: retries on network timeout", async () => {
    const timeout = new Error("fetch timed out");
    fetchSpy
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as Response);

    const api = new TelegramApi("t");
    const buf = await api.downloadFile("voice/abc.ogg");

    expect(buf).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("downloadFile: does NOT retry on 404 (expired file = permanent)", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    } as unknown as Response);

    const api = new TelegramApi("t");
    await expect(api.downloadFile("voice/expired.ogg")).rejects.toThrow(/downloadFile failed \(404\)/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("respects outer AbortSignal mid-retry", async () => {
    const ctrl = new AbortController();
    fetchSpy.mockImplementation(async () => {
      ctrl.abort(new Error("user cancelled"));
      throw new Error("network timeout");
    });

    const api = new TelegramApi("t");
    await expect(
      api.getUpdates(0, 1, ctrl.signal),
    ).rejects.toThrow(/network timeout|user cancelled/);
    // First attempt runs; after abort no further retries
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
