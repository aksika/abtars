/**
 * Authentication gate for the Web UI Dashboard.
 * Validates bearer tokens using constant-time comparison to prevent timing attacks.
 */

import * as crypto from "node:crypto";
import * as http from "node:http";

export class AuthGate {
  private readonly tokenBuffer: Buffer;

  constructor(private readonly token: string) {
    this.tokenBuffer = Buffer.from(token);
  }

  /**
   * Constant-time token comparison.
   * Returns `false` for empty/missing tokens, `true` only when the provided
   * token matches the configured secret.
   */
  validate(provided: string): boolean {
    if (!provided || !this.token) return false;

    const providedBuffer = Buffer.from(provided);
    if (providedBuffer.length !== this.tokenBuffer.length) return false;

    return crypto.timingSafeEqual(providedBuffer, this.tokenBuffer);
  }

  /**
   * Extract a token from an incoming HTTP request.
   * Checks the `Authorization: Bearer <token>` header first, then falls back
   * to the `?token=<token>` query parameter.
   */
  extractToken(req: http.IncomingMessage): string | null {
    // 1. Authorization header (Bearer scheme)
    const authHeader = req.headers["authorization"];
    if (authHeader) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match?.[1]) return match[1];
    }

    // 2. Query parameter
    const url = req.url;
    if (url) {
      const qIdx = url.indexOf("?");
      if (qIdx !== -1) {
        const params = new URLSearchParams(url.slice(qIdx));
        const tokenParam = params.get("token");
        if (tokenParam) return tokenParam;
      }
    }

    return null;
  }

  /**
   * Middleware-style guard. Returns `true` if the request is authorized.
   * Sends a 401 JSON response and returns `false` otherwise.
   */
  guard(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const provided = this.extractToken(req);
    if (provided && this.validate(provided)) return true;

    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
}
