/**
 * Integration: ActionGate — #790 auth gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionGate } from "../../components/action-gate.js";

describe("ActionGate integration (#790)", () => {
  let gate: ActionGate;
  let tmpDir: string;
  let notifyCalls: Array<{ text: string; buttons: Array<{ text: string; data: string }> }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "authgate-"));
    gate = new ActionGate(tmpDir);
    notifyCalls = [];
    gate.setNotify(async (text, buttons) => { notifyCalls.push({ text, buttons }); });
  });

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("blocks action and sends Telegram keyboard prompt", async () => {
    const authPromise = gate.requestAuth("bash-auth", "sudo rm -rf /tmp/test");

    // Give the async notify a tick to fire
    await new Promise(r => setTimeout(r, 10));

    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]!.text).toContain("sudo rm -rf /tmp/test");
    expect(notifyCalls[0]!.buttons.length).toBe(3);
    expect(notifyCalls[0]!.buttons[0]!.text).toContain("Allow once");

    // Simulate deny
    const callbackData = notifyCalls[0]!.buttons[2]!.data; // "❌ Deny"
    gate.handleCallback(callbackData);

    const granted = await authPromise;
    expect(granted).toBe(false);
  });

  it("allows action after master clicks Allow once", async () => {
    const authPromise = gate.requestAuth("bash-auth", "pkill -9 node");

    await new Promise(r => setTimeout(r, 10));

    const callbackData = notifyCalls[0]!.buttons[0]!.data; // "✓ Allow once"
    gate.handleCallback(callbackData);

    const granted = await authPromise;
    expect(granted).toBe(true);
  });

  it("token is one-use and expires", () => {
    const token = gate.generateToken("secret-recall", "salary");

    // First use: valid
    expect(gate.validateToken(token)).toBe(true);

    // Second use: consumed
    expect(gate.validateToken(token)).toBe(false);
  });

  it("expired token is rejected", () => {
    const token = gate.generateToken("secret-recall", "password");

    // Manually expire it by accessing internals (tokens Map)
    const tokenMap = (gate as any).tokens as Map<string, { expiresAt: number }>;
    const entry = tokenMap.get(token);
    if (entry) entry.expiresAt = Date.now() - 1000;

    expect(gate.validateToken(token)).toBe(false);
  });

  it("Always allow stores rule — subsequent requests auto-grant", async () => {
    const authPromise = gate.requestAuth("bash-auth", "docker ps");
    await new Promise(r => setTimeout(r, 10));

    // Click "Always allow"
    const callbackData = notifyCalls[0]!.buttons[1]!.data; // "🔓 Always allow"
    gate.handleCallback(callbackData);
    await authPromise;

    // Second request for same action — should auto-grant (no notify)
    notifyCalls = [];
    const granted = await gate.requestAuth("bash-auth", "docker ps");
    expect(granted).toBe(true);
    expect(notifyCalls.length).toBe(0); // No Telegram prompt sent
  });
});
