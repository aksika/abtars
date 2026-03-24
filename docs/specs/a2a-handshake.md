# A2A Handshake Protocol — KP (AgentBridge)

## Shared Secret

```
1b81ab8d47191ee700d35e5fb2af8a4c288fb65f6aabaa163084eff88554180d
```

Store this in your config. Never send it over the wire.

## Endpoint

All messages go to: `POST http://<KP_HOST>:3001/api/agent/prompt`

Content-Type: `application/json`

## Protocol Flow

### 1. Hello (you initiate)

```json
{
  "type": "hello",
  "name": "Molty",
  "challenge": "<random 64-char hex nonce you generate>"
}
```

KP responds:

```json
{
  "type": "hello",
  "name": "KP",
  "response": "<HMAC-SHA256 of YOUR challenge using shared secret>",
  "challenge": "<KP's random 64-char hex nonce>"
}
```

Verify `response` matches `HMAC-SHA256(your_challenge, shared_secret)`. If it doesn't, KP is not who he claims — abort.

### 2. Hello-Ack (prove you know the secret)

```json
{
  "type": "hello-ack",
  "response": "<HMAC-SHA256 of KP's challenge using shared secret>"
}
```

KP responds:

```json
{ "ok": true }
```

Session is now authenticated. Both sides proved knowledge of the secret without transmitting it.

### 3. Send Prompts (normal operation)

```json
{ "prompt": "your message here" }
```

KP responds:

```json
{ "response": "KP's reply", "sessionKey": "agent:molty" }
```

### 4. Close Session (when done)

```json
{ "type": "close" }
```

KP responds:

```json
{ "ok": true }
```

## HMAC Computation

```
HMAC-SHA256(data=nonce, key=shared_secret) → hex string
```

In Node.js:
```js
crypto.createHmac('sha256', secret).update(nonce).digest('hex')
```

In Python:
```python
import hmac, hashlib
hmac.new(secret.encode(), nonce.encode(), hashlib.sha256).hexdigest()
```

## If You Skip Hello

KP will respond to your first prompt with:

```json
{
  "hello": { "name": "KP", "challenge": "..." },
  "error": "hello_required",
  "message": "Hello, I'm KP. Who are you? Please authenticate."
}
```

Your prompt won't be processed until you complete the handshake.

## Message Prefixes in Logs

- Your messages appear as `[Molty]`
- KP's messages appear as `[KP]`
