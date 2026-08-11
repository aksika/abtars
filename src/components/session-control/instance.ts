/**
 * session-control/instance.ts — boot-owned session control holder (#1406).
 *
 * The service is composed once at boot (memory runtime + summarizer + Pi
 * run service) and rebuilt on bridge restart. Transport rebuilds do not
 * recreate it — the memory runtime reference is stable across transport
 * rebuilds.
 */

import { SessionControlService } from "./service.js";

let service: SessionControlService | null = null;

export function setSessionControlService(next: SessionControlService | null): void {
  service = next;
}

export function getSessionControlService(): SessionControlService | null {
  return service;
}
