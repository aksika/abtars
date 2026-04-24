import { request as httpRequest } from "node:http";
import { createHmac, randomBytes } from "node:crypto";

const KP_HOST = "localhost";
const KP_PORT = 3001;
const SHARED_SECRET = process.env.AGENT_API_TOKEN ?? "";
const AGENT_NAME = "Molty";

let authenticated = false;

function hmac(data) {
  return createHmac("sha256", SHARED_SECRET).update(data).digest("hex");
}

function kpFetch(path, opts = {}) {
  const body = opts.body || null;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: KP_HOST, port: KP_PORT, path, method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      timeout: 120_000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`KP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("KP request timed out (120s)")); });
    req.on("error", (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

async function ensureAuth() {
  if (authenticated) return;
  if (!SHARED_SECRET) throw new Error("AGENT_API_TOKEN not set");

  // Step 1: Hello with our challenge
  const ourChallenge = randomBytes(32).toString("hex");
  const hello = await kpFetch("/api/agent/prompt", {
    method: "POST",
    body: JSON.stringify({ type: "hello", name: AGENT_NAME, challenge: ourChallenge }),
  });

  // Verify KP's response to our challenge
  if (hello.response !== hmac(ourChallenge)) {
    throw new Error("KP failed challenge-response — not authenticated");
  }

  // Step 2: Hello-ack — prove we know the secret
  const ack = await kpFetch("/api/agent/prompt", {
    method: "POST",
    body: JSON.stringify({ type: "hello-ack", response: hmac(hello.challenge) }),
  });

  if (!ack.ok) throw new Error("KP rejected hello-ack");
  authenticated = true;
}

function txt(s) { return { content: [{ type: "text", text: s }] }; }

export default function (api) {
  api.registerTool({
    name: "kiro_professor_ask",
    description: "Ask Kiro Professor a question. Returns the full response. Use for coding questions, architecture advice, debugging help, or knowledge retrieval.",
    parameters: { type: "object", properties: { prompt: { type: "string", description: "The question or request to send" } }, required: ["prompt"] },
    async execute(_id, params) {
      await ensureAuth();
      const res = await kpFetch("/api/agent/prompt", { method: "POST", body: JSON.stringify({ prompt: params.prompt }) });
      return txt(res.response || JSON.stringify(res));
    },
  });

  api.registerTool({
    name: "kiro_professor_status",
    description: "Check if Kiro Professor is online and ready.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      try {
        const res = await kpFetch("/api/agent/status");
        return txt(res.ready ? `Kiro Professor online (session: ${res.sessionKey})` : "Kiro Professor not ready");
      } catch (e) { return txt(`Kiro Professor offline: ${e.message}`); }
    },
  });

  api.registerTool({
    name: "kiro_professor_reset",
    description: "Reset the Kiro Professor conversation session. Use when you want a fresh context.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      await kpFetch("/api/agent/prompt", { method: "POST", body: JSON.stringify({ type: "close" }) });
      authenticated = false;
      return txt("Kiro Professor session reset.");
    },
  });
}
