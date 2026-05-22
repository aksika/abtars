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

  it("advances offset past failed handlers (fire-and-forget)", async () => {
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

    // Offset advances to end of batch immediately — handlers are fire-and-forget.
    expect(store.value).toBe(203);
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

  it("advances offset immediately regardless of handler completion order", async () => {
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
        if (u.update_id === 300) await gate; // 300 blocks
      },
      store,
    );
    await poller.start();
    await sleep(100);

    // Offset advances immediately — doesn't wait for handler 300 to finish.
    expect(store.value).toBe(303);

    resolve301();
    poller.stop();
    await sleep(100);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
