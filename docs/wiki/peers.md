# Peer-to-Peer (A2A)

Configured abTARS instances can communicate through an authenticated peer connection. The Agent API listens on port 7100 by default.

## Choose the interaction

| Need | Tool | Behavior |
|------|------|----------|
| Discussion or follow-up questions | peer_session | Cardless conversation without tools or side effects |
| Durable delegated work | peer_ask_help | The receiving instance can accept or decline, then return a terminal result |

Both tools require a configured peer connection. For the persistent WebSocket route, one configured side initiates the connection; disconnected peers are not discovered automatically.

## Authentication and transport

Peer requests use Ed25519 signatures, and the Agent API uses TLS. Each configured peer entry includes its address and public verification key. Keep each instance's private identity material on that instance.

## Configuration

Configure each peer in the local abTARS settings. The peer entry uses:

| Field | Purpose |
|-------|---------|
| peer name | Name chosen for this entry in the local peer configuration |
| host | Peer address reachable from this instance |
| port | Peer Agent API port; defaults to 7100 |
| verifyKey | Peer's public key used to verify its identity and signed requests |
| trust | Local access level for the peer |
| maxClass | Optional ceiling for memory classes shared with that peer |

Configure the other instance with the corresponding public verification key and a reachable address. Use a private network or firewall rules that expose only the connections you intend to allow.

See [Secure Peer Connections](./peers-tls.md) for connection checks.
