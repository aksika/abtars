# TLS Certificate Setup

How to generate and exchange certificates for secure A2A communication between abTARS instances.

## Generate a certificate

Run on each host:

```bash
cd ~/.abtars/config
openssl req -x509 -newkey ed25519 \
  -keyout identity.tls.key \
  -out identity.crt \
  -days 3650 \
  -nodes \
  -subj "/CN=$(hostname)"
chmod 600 identity.tls.key
```

This creates a 10-year self-signed Ed25519 certificate. No CA needed.

## Get your fingerprint

```bash
openssl x509 -in ~/.abtars/config/identity.crt -fingerprint -sha256 -noout
```

Output:
```
sha256 Fingerprint=9D:45:C0:6E:A9:F1:EF:3E:...
```

## Exchange certificates

Each peer needs the other's fingerprint and certificate PEM. Send your `identity.crt` to your peer (it's not secret — it's a public certificate).

```bash
# Get your cert PEM (send this to your peer)
cat ~/.abtars/config/identity.crt
```

## Add peer's cert to peers.json

On **your** host, add the peer's cert info:

```json
{
  "peers": {
    "peer-b": {
      "host": "<peer-tailscale-ip>",
      "port": 3100,
      "token": "...",
      "verifyKey": "...",
      "certFingerprint": "B3:9A:5D:54:97:02:52:8E:...",
      "certPem": "-----BEGIN CERTIFICATE-----\nMIIBNDCB56AD...\n-----END CERTIFICATE-----"
    }
  }
}
```

Do this on **both** hosts — each needs the other's cert.

## Verify

After restarting both bridges:

```bash
# Check TLS is active in logs
grep "TLS" ~/.abtars/logs/bridge-$(date +%F).log
# Expected: "TLS 1.3 enabled for agent-api (self-signed cert)"
```

Test the connection:
```bash
curl -sk https://<peer-ip>:3100/health
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "identity.crt not found" | Run the openssl command above |
| "agent-api starting without TLS" | Cert files missing — check paths |
| "cert fingerprint mismatch" | Wrong cert in peers.json — re-exchange |
| "EADDRINUSE :3100" | Old process holding port — `fuser -k 3100/tcp` |
| `abtars doctor` warns about certs | Run `chmod 600` on both cert files |

## Notes

- Certificates are valid for 10 years — no rotation needed
- The private key (`identity.tls.key`) never leaves the host
- The certificate (`identity.crt`) is safe to share — it's public
- If you regenerate a cert, you must exchange the new fingerprint with all peers
