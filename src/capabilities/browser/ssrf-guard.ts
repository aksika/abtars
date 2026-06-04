/**
 * SSRF guard — reject private/internal IP addresses.
 * Adapted from NemoClaw's ssrf.ts.
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { resolve4, resolve6 } from "node:dns/promises";

const PRIVATE_RANGES_V4: ReadonlyArray<[number, number, number]> = [
  // [network, mask, bits]  — network & mask === candidate & mask → private
  [0x7F000000, 0xFF000000, 8],   // 127.0.0.0/8
  [0x0A000000, 0xFF000000, 8],   // 10.0.0.0/8
  [0xAC100000, 0xFFF00000, 12],  // 172.16.0.0/12
  [0xC0A80000, 0xFFFF0000, 16],  // 192.168.0.0/16
  [0xA9FE0000, 0xFFFF0000, 16],  // 169.254.0.0/16 (link-local)
  [0x64400000, 0xFFC00000, 10],  // 100.64.0.0/10 (CGNAT)
  [0x00000000, 0xFFFFFFFF, 32],  // 0.0.0.0
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_RANGES_V4.some(([net, mask]) => (n & mask) >>> 0 === (net & mask) >>> 0);
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fd") || lower.startsWith("fe80") || lower.startsWith("::ffff:127.");
}

/** Check if a hostname resolves to a private IP. Resolves DNS to catch rebinding. */
export async function isPrivateHost(hostname: string): Promise<boolean> {
  // Direct IP check
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return isPrivateV4(hostname);
  if (hostname.includes(":")) return isPrivateV6(hostname);
  if (hostname === "localhost") return true;

  // DNS resolution check (catches DNS rebinding)
  const timeout = (p: Promise<string[]>): Promise<string[]> =>
    Promise.race([p, new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 2000))]);

  try {
    const v4 = await timeout(resolve4(hostname));
    if (v4.some(isPrivateV4)) return true;
  } catch (err) { logAndSwallow("ssrf_guard", "op", err); }

  try {
    const v6 = await timeout(resolve6(hostname));
    if (v6.some(isPrivateV6)) return true;
  } catch (err) { logAndSwallow("ssrf_guard", "op", err); }

  return false;
}
