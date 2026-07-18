import type {
  RemotePiEventV1,
  RemotePiEventsListRequestV1,
  RemotePiEventsListResponseV1,
  RemotePiEventsAckRequestV1,
  RemotePiEventsAckResponseV1,
  RemotePiControlRequestV1,
  RemotePiControlResponseV1,
} from "./remote-pi-types.js";
import type { PeerHelpRequestV1, PeerHelpResponseV1, PeerHelpStatusRequestV1, PeerHelpStatusV1, PeerHelpWithdrawV1 } from "../peer-help/contract.js";

export interface PeerHealth {
  name: string;
  lastSeen: number;
  load: number;
  sessions: number;
  capabilities: string[];
  version: string;
  alive: boolean;
}

export interface PeerCard {
  name: string;
  host: string;
  port: number;
  capabilities?: string[];
}

export interface PeerMessage {
  type: "ask" | "callback" | "channel";
  payload: Record<string, unknown>;
}

export interface PeerHelpTransport {
  askHelp(peer: string, request: PeerHelpRequestV1): Promise<PeerHelpResponseV1>;
  getHelpStatus(peer: string, request: PeerHelpStatusRequestV1): Promise<PeerHelpStatusV1>;
  withdrawHelp(peer: string, request: PeerHelpWithdrawV1): Promise<{ acknowledged: boolean; owner_action?: string }>;
}

export interface PeerTransport extends PeerHelpTransport {
  send(peer: string, message: PeerMessage): Promise<unknown>;
  broadcast(message: PeerMessage): Promise<void>;
  discover(): PeerCard[];
  onMessage(handler: (from: string, message: PeerMessage) => void): void;

  pushChannelMessage(peer: string, cardId: number, from: string, message: string, createdAt: string): Promise<void>;

  pushLifecycleEvent(peer: string, event: RemotePiEventV1): Promise<void>;
  listRemotePiEvents(peer: string, request: RemotePiEventsListRequestV1): Promise<RemotePiEventsListResponseV1>;
  acknowledgeRemotePiEvents(peer: string, request: RemotePiEventsAckRequestV1): Promise<RemotePiEventsAckResponseV1>;
  sendRemotePiControl(peer: string, request: RemotePiControlRequestV1): Promise<RemotePiControlResponseV1>;
}
