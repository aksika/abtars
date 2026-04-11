# #127 Prompt Injection Scanner — Spec

**Date:** 2026-04-12
**Status:** Planned
**Priority:** MEDIUM
**Source:** [PayloadsAllTheThings](https://swisskyrepo.github.io/PayloadsAllTheThings/Prompt%20Injection/), NemoClaw study

## Approach

Pure TypeScript pattern scanner. No Python, no ML, no external deps. ~1ms per call. Same pattern as emotion-tagger and importance-flagger.

## API

```typescript
type InjectionFlag = {
  category: string;
  pattern: string;
  weight: number;
};

type ScanResult = {
  score: number;        // 0.0–1.0, max weight of matched patterns
  flags: InjectionFlag[];
  safe: boolean;        // score < 0.7
};

function scanForInjection(text: string): ScanResult;
```

## Detection Categories

### 1. Instruction Override (weight: 0.9)
Direct attempts to override system instructions.
```
ignore previous instructions
disregard any previous
disregard above
forget everything
forget all prior
new instructions
override instructions
do not follow your rules
ignore all above
ignore the above
ignore your instructions
stop being
you must now
from now on you will
```

### 2. Role Hijack (weight: 0.8)
Attempts to change the agent's identity or remove restrictions.
```
you are now
act as if
pretend you're
pretend to be
developer mode
DAN mode
jailbreak
no restrictions
without any restrictions
bypass safety
bypass filters
unrestricted mode
you have been freed
you can do anything
answer without restrictions
```

### 3. System Prompt Leak (weight: 0.7)
Attempts to extract the system prompt or configuration.
```
show system prompt
reveal your instructions
what are your rules
print the prompt
display your instructions
repeat the above
show me your prompt
output your system
what were you told
show your configuration
reveal your system
tell me your instructions
```

### 4. Format Delimiter Escape (weight: 0.9)
Injection of LLM-specific control tokens/delimiters.
```
<<SYS>>
<</SYS>>
[INST]
[/INST]
<|im_start|>
<|im_end|>
<|system|>
<|user|>
<|assistant|>
</s>
{"role": "system"
{"role":"system"
[system](#instructions)
```

### 5. Exfiltration (weight: 0.9)
Attempts to send data to external endpoints.
```
send to http
fetch(http
curl http
wget http
webhook
exfiltrate
upload to
post to http
forward to http
transmit to
append to url
url encode the result and append
access and load the resulting url
```
Also: URL pattern immediately after data reference (regex: data extraction + URL).

### 6. Secret Access (weight: 0.7)
Attempts to access secrets, credentials, or sensitive files. Only flagged when combined with extraction verbs (read, show, display, print, reveal, give).
```
.env file
API_KEY
api key
password
secret key
credentials
private key
access token
auth token
bot token
```

### 7. Code Execution (weight: 0.9)
Attempts to execute arbitrary code.
```
eval(
exec(
os.popen(
import os
subprocess
__class__
__mro__
__subclasses__
__globals__
__builtins__
child_process
require("child_process
spawn(
execSync(
```

### 8. Base64 Payload (weight: 0.6)
Base64-encoded blocks > 20 chars. Decode and re-scan the decoded content. If decoded content triggers any other category, escalate weight to that category's weight.

Detection: `/[A-Za-z0-9+/]{20,}={0,2}/` → decode → re-scan.

### 9. Unicode Obfuscation (weight: 0.6)
Mathematical bold/italic unicode characters used to bypass keyword filters.
```
Unicode ranges:
  𝐀-𝐙 (U+1D400–U+1D419) Mathematical Bold Capital
  𝐚-𝐳 (U+1D41A–U+1D433) Mathematical Bold Small
  𝗔-𝗭 (U+1D5D4–U+1D5ED) Mathematical Sans-Serif Bold Capital
  𝗮-𝘇 (U+1D5EE–U+1D607) Mathematical Sans-Serif Bold Small
  𝘈-𝘡 (U+1D608–U+1D621) Mathematical Sans-Serif Italic Capital
```
Also: zero-width characters (U+200B, U+200C, U+200D, U+FEFF) — strip before scanning.

### 10. HTML/Comment Injection (weight: 0.7)
Instructions hidden in HTML comments or encoded as HTML entities.
```
<!-- ... instructions ... -->
/* ... instructions ... */
&#x65;&#x76;&#x61;&#x6C;  (HTML entity encoding)
```
Decode HTML entities before scanning.

### 11. Indirect Injection (weight: 0.5)
Instructions embedded in structured data fields.
```
Metadata fields containing instruction-like text
JSON "message" or "content" fields with override language
EXIF-style key-value pairs with instructions as values
```

### 12. Cross-Plugin Abuse (weight: 0.9)
Multi-step attack patterns combining instruction override + exfiltration.
```
***IMPORTANT NEW INSTRUCTIONS***
do not print anything
without printing anything
you do not have to ask for permission
just follow the instructions
```

### 13. Prompt Sandwiching (weight: 0.7)
Legitimate content wrapping a malicious payload. Detected by: instruction override patterns appearing after a large block of benign text (>500 chars of normal content followed by override pattern).

### 14. Reverse Shell / Backdoor (weight: 1.0)
```
bash -i >& /dev/tcp
nc -e /bin/sh
reverse shell
/dev/tcp/
mkfifo /tmp
curl -O http
wget http.*backdoor
python -c "import
python3 -c "import
```

## Implementation

### File: `packages/memory/src/injection-scanner.ts`

```
1. Strip zero-width unicode chars
2. Normalize mathematical unicode → ASCII
3. Decode HTML entities
4. Scan for all pattern categories
5. Detect and decode base64 blocks → re-scan decoded content
6. Return { score, flags, safe }
```

### Call Sites

| Where | When | Action on flag |
|---|---|---|
| `abmind store` | Before storing memory | Log warning, store with `injection_flagged=true` metadata |
| Skill loader | On skill file load | Log warning, skip skill if score >= 0.9 |
| Browse tool output | After scraping | Log warning, include warning in agent context |

### Not scanned (overkill for single-user)
- User messages from Telegram/Discord (you're the only user)
- Agent's own responses (trusted)
- Core files (deployed from repo, not user-editable)

## Effort

~2hr for scanner + 3 call sites.

## References

- [PayloadsAllTheThings - Prompt Injection](https://swisskyrepo.github.io/PayloadsAllTheThings/Prompt%20Injection/)
- [TakSec/Prompt-Injection-Everywhere](https://github.com/TakSec/Prompt-Injection-Everywhere)
- [NVIDIA/garak](https://github.com/NVIDIA/garak) — LLM vulnerability scanner
- [Prompt-Shield](https://github.com/prompt-shield) — 22 detectors, DeBERTa classifier
- [Vigil (vigil-llm)](https://github.com/deadbits/vigil-llm) — open-source prompt injection monitor
- [LLM Guard](https://github.com/protectai/llm-guard) — PromptInjection scanner by Protect AI
