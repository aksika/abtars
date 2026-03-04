import { describe, it, expect, beforeEach } from "vitest";
import { serialize, parse, buildRequest, resetRequestId, nextRequestId } from "./jsonrpc.js";
import type { AcpRequest, AcpResponse, AcpNotification } from "../types/index.js";

describe("jsonrpc", () => {
  beforeEach(() => {
    resetRequestId();
  });

  describe("serialize", () => {
    it("serializes a request to newline-delimited JSON", () => {
      const req: AcpRequest = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
      const result = serialize(req);
      expect(result).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    });

    it("serializes a response", () => {
      const res: AcpResponse = { jsonrpc: "2.0", id: 1, result: { ok: true } };
      const result = serialize(res);
      expect(result.endsWith("\n")).toBe(true);
      expect(JSON.parse(result)).toEqual(res);
    });
  });

  describe("parse", () => {
    it("parses a response (has id)", () => {
      const msg = parse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
      expect((msg as AcpResponse).id).toBe(1);
      expect((msg as AcpResponse).result).toEqual({ ok: true });
    });

    it("parses a notification (has method, no id)", () => {
      const msg = parse('{"jsonrpc":"2.0","method":"session/update","params":{"type":"chunk"}}');
      expect((msg as AcpNotification).method).toBe("session/update");
    });

    it("throws on empty string", () => {
      expect(() => parse("")).toThrow("empty");
    });

    it("throws on invalid JSON-RPC version", () => {
      expect(() => parse('{"jsonrpc":"1.0","id":1}')).toThrow("version");
    });

    it("throws on message with neither id nor method", () => {
      expect(() => parse('{"jsonrpc":"2.0"}')).toThrow("Unrecognized");
    });

    it("handles trailing newline", () => {
      const msg = parse('{"jsonrpc":"2.0","id":2,"result":null}\n');
      expect((msg as AcpResponse).id).toBe(2);
    });
  });

  describe("buildRequest", () => {
    it("builds a request with incrementing IDs", () => {
      const r1 = buildRequest("initialize", { version: "1.0" });
      const r2 = buildRequest("session/new", { cwd: "/tmp" });
      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
      expect(r1.jsonrpc).toBe("2.0");
      expect(r1.method).toBe("initialize");
    });
  });

  describe("nextRequestId", () => {
    it("returns monotonically increasing IDs", () => {
      const a = nextRequestId();
      const b = nextRequestId();
      expect(b).toBeGreaterThan(a);
    });
  });

  describe("round-trip", () => {
    it("serialize then parse yields equivalent object", () => {
      const req: AcpRequest = { jsonrpc: "2.0", id: 99, method: "test", params: { key: "val" } };
      const serialized = serialize(req);
      const parsed = parse(serialized);
      expect(parsed).toEqual(req);
    });
  });
});
