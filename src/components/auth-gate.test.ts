import { describe, it, expect } from "vitest";
import { AuthGate } from "./auth-gate.js";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal mock IncomingMessage with the given headers and url. */
function mockReq(
  opts: { authorization?: string; url?: string } = {},
): IncomingMessage {
  return {
    headers: opts.authorization
      ? { authorization: opts.authorization }
      : {},
    url: opts.url ?? "/",
  } as unknown as IncomingMessage;
}

/** Build a minimal mock ServerResponse that captures status and body. */
function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    writeHead(status: number) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      res._body = body ?? "";
      return res;
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

// ── validate ────────────────────────────────────────────────────────────────

describe("AuthGate.validate", () => {
  const gate = new AuthGate("my-secret-token");

  it("returns true for matching token", () => {
    expect(gate.validate("my-secret-token")).toBe(true);
  });

  it("returns false for non-matching token", () => {
    expect(gate.validate("wrong-token")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(gate.validate("")).toBe(false);
  });

  it("returns false for token with different length", () => {
    expect(gate.validate("short")).toBe(false);
  });

  it("returns false when configured token is empty", () => {
    const emptyGate = new AuthGate("");
    expect(emptyGate.validate("anything")).toBe(false);
  });
});

// ── extractToken ────────────────────────────────────────────────────────────

describe("AuthGate.extractToken", () => {
  const gate = new AuthGate("token");

  it("extracts token from Authorization Bearer header", () => {
    const req = mockReq({ authorization: "Bearer abc123" });
    expect(gate.extractToken(req)).toBe("abc123");
  });

  it("extracts token from query parameter", () => {
    const req = mockReq({ url: "/ws?token=xyz789" });
    expect(gate.extractToken(req)).toBe("xyz789");
  });

  it("prefers Authorization header over query parameter", () => {
    const req = mockReq({
      authorization: "Bearer from-header",
      url: "/ws?token=from-query",
    });
    expect(gate.extractToken(req)).toBe("from-header");
  });

  it("returns null when neither header nor query param present", () => {
    const req = mockReq({ url: "/api/test" });
    expect(gate.extractToken(req)).toBeNull();
  });

  it("returns null for malformed Authorization header", () => {
    const req = mockReq({ authorization: "Basic abc123" });
    expect(gate.extractToken(req)).toBeNull();
  });

  it("handles Bearer header case-insensitively", () => {
    const req = mockReq({ authorization: "bearer my-token" });
    expect(gate.extractToken(req)).toBe("my-token");
  });

  it("returns null when url is undefined", () => {
    const req = { headers: {} } as unknown as IncomingMessage;
    expect(gate.extractToken(req)).toBeNull();
  });
});

// ── guard ───────────────────────────────────────────────────────────────────

describe("AuthGate.guard", () => {
  const gate = new AuthGate("secret");

  it("returns true for valid token", () => {
    const req = mockReq({ authorization: "Bearer secret" });
    const res = mockRes();
    expect(gate.guard(req, res)).toBe(true);
  });

  it("returns false and sends 401 for invalid token", () => {
    const req = mockReq({ authorization: "Bearer wrong" });
    const res = mockRes();
    expect(gate.guard(req, res)).toBe(false);
    expect(res._status).toBe(401);
    expect(JSON.parse(res._body)).toEqual({ error: "Unauthorized" });
  });

  it("returns false and sends 401 when no token provided", () => {
    const req = mockReq();
    const res = mockRes();
    expect(gate.guard(req, res)).toBe(false);
    expect(res._status).toBe(401);
  });

  it("accepts token from query parameter", () => {
    const req = mockReq({ url: "/ws?token=secret" });
    const res = mockRes();
    expect(gate.guard(req, res)).toBe(true);
  });
});

// Feature: kiro-professor-webui, Property 2: Token extraction from requests
import fc from "fast-check";

describe("AuthGate.extractToken — Property 2: Token extraction from requests", () => {
  const gate = new AuthGate("irrelevant");

  it("returns the exact token from Authorization: Bearer header", () => {
    /**
     * Validates: Requirements 3.1, 3.2
     *
     * For any HTTP request with a token in the Authorization: Bearer header,
     * extractToken() returns that exact token.
     */
    const tokenArb = fc.string({ minLength: 1 }).filter((s) => !/\s/.test(s));

    fc.assert(
      fc.property(tokenArb, (token) => {
        const req = mockReq({ authorization: `Bearer ${token}` });
        expect(gate.extractToken(req)).toBe(token);
      }),
      { numRuns: 100 },
    );
  });

  it("returns the exact token from ?token= query parameter", () => {
    /**
     * Validates: Requirements 3.1, 3.2
     *
     * For any HTTP request with a token in the ?token= query parameter,
     * extractToken() returns that exact token.
     */
    // Use alphanumeric-ish tokens to avoid URL encoding edge cases
    const tokenArb = fc.string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-_".split("")),
      minLength: 1,
    });

    fc.assert(
      fc.property(tokenArb, (token) => {
        const req = mockReq({ url: `/ws?token=${token}` });
        expect(gate.extractToken(req)).toBe(token);
      }),
      { numRuns: 100 },
    );
  });

  it("returns null when neither header nor query param is present", () => {
    /**
     * Validates: Requirements 3.1, 3.2
     *
     * For any HTTP request with no Authorization header and no token query
     * parameter, extractToken() returns null.
     */
    const pathArb = fc.string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz/".split("")),
      minLength: 1,
    }).map((p) => `/${p}`);

    fc.assert(
      fc.property(pathArb, (path) => {
        const req = mockReq({ url: path });
        expect(gate.extractToken(req)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: kiro-professor-webui, Property 3: Token validation correctness

describe("AuthGate.validate — Property 3: Token validation correctness", () => {
  it("returns true iff provided token equals configured token", () => {
    /**
     * Validates: Requirements 3.3, 3.4
     *
     * For any two non-empty strings A and B, validate(A) with configured
     * token B returns true iff A === B.
     */
    fc.assert(
      fc.property(
        fc.tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 })),
        ([provided, configured]) => {
          const gate = new AuthGate(configured);
          const result = gate.validate(provided);
          if (provided === configured) {
            expect(result).toBe(true);
          } else {
            expect(result).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns false when provided token is empty", () => {
    /**
     * Validates: Requirements 3.3, 3.4
     *
     * Empty provided tokens always return false, regardless of configured token.
     */
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (configured) => {
        const gate = new AuthGate(configured);
        expect(gate.validate("")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("returns false when configured token is empty", () => {
    /**
     * Validates: Requirements 3.3, 3.4
     *
     * Empty configured tokens always cause validate to return false.
     */
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (provided) => {
        const gate = new AuthGate("");
        expect(gate.validate(provided)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
