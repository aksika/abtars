import { execSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;

/**
 * #1621: the Kanban CLI must reach the HTTPS-only Agent API (#1305) using the
 * port advertised in `~/.abtars/state/agent-api.port`, and must not leave TLS
 * certificate verification disabled behind it. A real self-signed HTTPS
 * listener (not a mocked fetch) reproduces the escaped HTTP/HTTPS mismatch:
 * this test goes red if the CLI regresses to plaintext HTTP.
 */
describe("kanban CLI against the HTTPS Agent API (#1621)", () => {
  let tmpDir: string;
  let server: Server;
  let requests: Array<{ method: string; url: string; body: Record<string, unknown> }>;
  let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined;
  const originalReject = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "abtars-kanban-cli-"));
    process.env.HOME = tmpDir;

    const { privateKey: privKeyObj } = generateKeyPairSync("ed25519");
    const keyPem = privKeyObj.export({ type: "pkcs8", format: "pem" }) as string;
    const keyPath = join(tmpDir, "identity.tls.key");
    writeFileSync(keyPath, keyPem, { mode: 0o600 });
    execSync(
      `openssl req -x509 -key "${keyPath}" -out "${join(tmpDir, "identity.crt")}" -days 3650 -nodes -subj "/CN=localhost"`,
      { stdio: "pipe" },
    );
    const certPem = readFileSync(join(tmpDir, "identity.crt"), "utf-8");

    requests = [];
    server = createServer({ key: keyPem, cert: certPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, card_id: 42, status: "queued" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as { port: number };
    mkdirSync(join(tmpDir, ".abtars", "state"), { recursive: true });
    writeFileSync(join(tmpDir, ".abtars", "state", "agent-api.port"), String(addr.port), "utf-8");
  });

  afterEach(async () => {
    stdoutSpy?.mockRestore();
    stdoutSpy = undefined;
    process.env.HOME = originalHome;
    if (originalReject === undefined) {
      delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    } else {
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = originalReject;
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("posts the card over HTTPS and restores TLS verification", async () => {
    const { kanban } = await import("./kanban.js");
    const output: string[] = [];
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const code = await kanban([
      "create",
      "--title", "Test card",
      "--goal", "Verify the HTTPS boundary",
      "--type", "B",
      "--priority", "HIGH",
      "--delivery-mode", "notify",
    ]);

    expect(code).toBe(0);
    expect(output.join("")).toContain("+ Card #42 created (queued)");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("/v1/kanban");
    expect(requests[0]!.body).toMatchObject({
      type: "B",
      title: "Test card",
      goal: "Verify the HTTPS boundary",
      source: "cli",
      priority: "HIGH",
      delivery_mode: "notify",
    });
    expect(process.env["NODE_TLS_REJECT_UNAUTHORIZED"]).toBe(originalReject);
  });
});
