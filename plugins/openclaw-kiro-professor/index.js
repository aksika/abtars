/**
 * openclaw-kiro-professor — Molty-side plugin that asks KP for answers (#373).
 *
 * Migrated from HMAC challenge-response (/api/agent/prompt) to OpenAI-compat
 * (/v1/chat/completions) with bearer auth. Net -40 LOC; stateless plugin.
 *
 * Env:
 *   KP_HOST           KP hostname/IP (default: localhost)
 *   KP_PORT           KP agent-api port (default: 3100)
 *   AGENT_API_TOKEN   Shared bearer token with KP (required)
 */

import { request as httpRequest } from "node:http";

const KP_HOST = process.env.KP_HOST ?? "localhost";
const KP_PORT = parseInt(process.env.KP_PORT ?? "3100", 10);
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN ?? "";
const SESSION_ID = "molty"; // isolates Molty's kiro-cli session from other X-Session-Id callers

function kpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: KP_HOST,
      port: KP_PORT,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": `Bearer ${AGENT_API_TOKEN}`,
        "X-Session-Id": SESSION_ID,
      },
      timeout: 120_000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`KP ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`KP returned non-JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("KP request timed out (120s)")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function kpGet(path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: KP_HOST,
      port: KP_PORT,
      path,
      method: "GET",
      headers: { "Authorization": `Bearer ${AGENT_API_TOKEN}` },
      timeout: 10_000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`KP ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("KP request timed out")); });
    req.on("error", reject);
    req.end();
  });
}

function txt(s) { return { content: [{ type: "text", text: s }] }; }

export default function (api) {
  api.registerTool({
    name: "kiro_professor_ask",
    description: "Ask Kiro Professor a question. Returns the full response. Use for coding questions, architecture advice, debugging help, or knowledge retrieval.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "The question or request to send" } },
      required: ["prompt"],
    },
    async execute(_id, params) {
      if (!AGENT_API_TOKEN) throw new Error("AGENT_API_TOKEN not set");
      const res = await kpPost("/v1/chat/completions", {
        model: "kp/default",
        messages: [{ role: "user", content: params.prompt }],
      });
      const content = res?.choices?.[0]?.message?.content ?? "";
      return txt(content || JSON.stringify(res));
    },
  });

  api.registerTool({
    name: "kiro_professor_status",
    description: "Check if Kiro Professor is online and ready.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      try {
        const res = await kpGet("/v1/models");
        const ok = Array.isArray(res?.data) && res.data.length > 0;
        return txt(ok ? `Kiro Professor online (${res.data.length} models)` : "Kiro Professor responded but no models listed");
      } catch (e) {
        return txt(`Kiro Professor offline: ${e.message}`);
      }
    },
  });

}
