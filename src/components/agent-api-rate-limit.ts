import { getEnv } from "./env-schema.js";

interface CallerWindow {
  hourly: number[];
  daily: number[];
}

const callers = new Map<string, CallerWindow>();

export function checkRateLimit(caller: string): { allowed: boolean; retryAfterMs?: number } {
  const { maxAgentCallPerHour, maxAgentCallPerDay } = getEnv();
  const now = Date.now();
  const hourAgo = now - 3_600_000;
  const dayAgo = now - 86_400_000;

  let w = callers.get(caller);
  if (!w) { w = { hourly: [], daily: [] }; callers.set(caller, w); }

  w.hourly = w.hourly.filter(t => t > hourAgo);
  w.daily = w.daily.filter(t => t > dayAgo);

  if (w.hourly.length >= maxAgentCallPerHour) {
    return { allowed: false, retryAfterMs: w.hourly[0]! - hourAgo };
  }
  if (w.daily.length >= maxAgentCallPerDay) {
    return { allowed: false, retryAfterMs: w.daily[0]! - dayAgo };
  }

  w.hourly.push(now);
  w.daily.push(now);
  return { allowed: true };
}

// #949: Per-peer 10s rate limit on all A2A POST/DELETE endpoints
const peerLastPost = new Map<string, number>();
const PEER_POST_COOLDOWN_MS = 10_000;

export function checkPeerPostLimit(peer: string): boolean {
  const now = Date.now();
  const last = peerLastPost.get(peer);
  if (last && now - last < PEER_POST_COOLDOWN_MS) return false;
  peerLastPost.set(peer, now);
  return true;
}
