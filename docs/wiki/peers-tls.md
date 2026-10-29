# Secure Peer Connections

abTARS provisions and validates its local TLS identity for the Agent API. You do not need to generate certificates by hand or copy private identity material between instances.

## Configure a peer

For each known peer, configure its reachable host, Agent API port, and public verification key in the local peer settings. Configure the reciprocal peer entry on the other instance.

The public verification key is safe to share with the peer that needs to verify it. Keep private identity material on the instance that created it.

## Network requirements

The Agent API uses port 7100 by default. Make sure the configured address and port are reachable over the network used by the peers. For persistent WebSocket communication, one configured peer initiates the connection.

## Verify the connection

Use abtars status and abtars doctor to check local service health. If a peer is unavailable, check that both instances are running, the peer address and port are reachable, and the configured public verification key belongs to the intended peer. Review the bridge logs for connection errors.

See [Peer-to-Peer](./peers.md) for interaction types and peer configuration.
