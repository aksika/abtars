import { describe, it, expect, vi } from "vitest";
import { TelegramPoller } from "./telegram-poller.js";
import { createMemoryOffsetStore } from "./offset-store.js";
import type { TelegramApi } from "./telegram-api.js";

function mockApi(batches: Array<Array<{ update_id: number }>>): TelegramApi {
  let call = 0;
  return {
    getUpdates: vi.fn(async (_offset: number, _timeout: number, signal?: AbortSignal) => {
      const batch = batches[call];
      if (batch !== undefined) { call++; return batch; }
      // No more batches — simulate long-poll that respects abort.
      return new Promise<never[]>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error("aborted"));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener("abort", onAbort);
      });
    }),
  } as unknown as TelegramApi;
}

describe("TelegramPoller offset safety", () => {
  it("advances offset only after handler succeeds", async () => {
    const store = createMemoryOffsetStore(0);
    const handled: number[] = [];
    const api = mockApi([
      [{ update_id: 100 }, { update_id: 101 }],
      [], // second poll returns empty → loop exits via stop
    ]);

    const poller = new TelegramPoller(
      api, 0,
      async (u) => { handled.push(u.update_id); },
      store,
    );
    await poller.start();
    await sleep(200);
    poller.stop();
    await sleep(100);

    expect(handled).toEqual([100, 101]);
    expect(store.value).toBe(102);
  });

  it("does not advance offset past a failed handler", async () => {
    const store = createMemoryOffsetStore(0);
    const api = mockApi([
      [{ update_id: 200 }, { update_id: 201 }, { update_id: 202 }],
      [],
    ]);

    const poller = new TelegramPoller(
      api, 0,
      async (u) => {
        if (u.update_id === 201) throw new Error("handler fail");
      },
      store,
    );
    await poller.start();
    await sleep(200);
    poller.stop();
    await sleep(100);

    // Offset should stop at 201 (the failed one), not advance to 203.
    expect(store.value).toBe(201);
  });

  it("resumes from persisted offset on startup", async () => {
    const store = createMemoryOffsetStore(500);
    const api = mockApi([[], []]);

    const poller = new TelegramPoller(api, 0, async () => {}, store);
    await poller.start();
    await sleep(100);
    poller.stop();

    // getUpdates should have been called with offset=500
    expect(api.getUpdates).toHaveBeenCalledWith(500, expect.anything(), expect.anything());
  });

  it("handles out-of-order handler completion correctly", async () => {
    const store = createMemoryOffsetStore(0);
    let resolve301!: () => void;
    const gate = new Promise<void>(r => { resolve301 = r; });

    const api = mockApi([
      [{ update_id: 300 }, { update_id: 301 }, { update_id: 302 }],
      [],
    ]);

    const poller = new TelegramPoller(
      api, 0,
      async (u) => {
        if (u.update_id === 300) await gate; // 300 blocks until 301+302 finish
      },
      store,
    );
    await poller.start();
    await sleep(100);

    // 301 and 302 may have finished but 300 is still pending.
    // Offset must NOT advance past 300.
    expect(store.value).toBe(0);

    // Now unblock 300.
    resolve301();
    await sleep(200);
    poller.stop();
    await sleep(100);

    // All settled — offset should be 303.
    expect(store.value).toBe(303);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
