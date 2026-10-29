/**
 * session-dispatch.ts — #1555 transport-facing session boundary.
 *
 * The narrow set of session-manager operations the transport tool layer
 * consumes. Boot injects the live session manager through the tool dependency
 * setters; transport modules never import the concrete Spin instance at
 * runtime.
 */

import type {
  ManagedSession,
  SessionType,
  SpinRequest,
} from "../spin-types.js";

export interface SessionDispatch {
  createSubSession(
    userId: string,
    platform: string,
    type: SessionType,
  ): ManagedSession | string;

  getSessionById(sessionId: string): ManagedSession | undefined;

  spawnChild(
    parentCardId: number,
    request: Omit<SpinRequest, "type"> & { type?: SessionType },
  ): number;
}
