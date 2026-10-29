# Transport Configuration

Transport configuration lives in ~/.abtars/config/transport.json. It selects an execution route, assigns models to agents, and declares the providers those routes can use.

## Routes and provider transports

| Term | Meaning |
|------|---------|
| **pi-ai route** | Uses Pi's agent core and provider engine for API model requests. |
| **ACP route** | Connects to an ACP-compatible agent CLI. It does not require Pi. |
| **Provider transport** | The provider connection type: api, acp, or tmux. |

The default configuration includes pi-ai and ACP assignments. A provider must support the route where it is assigned.

## Example

~~~json
{
  "schemaVersion": 3,
  "activeRoute": "pi-ai",
  "routes": {
    "pi-ai": {
      "agents": {
        "main": { "model": "provider/model-name", "provider": "openrouter" }
      },
      "fallbacks": []
    },
    "acp": {
      "agents": {
        "main": { "model": "cli-model", "provider": "my-cli" }
      },
      "fallbacks": []
    }
  },
  "providers": {
    "my-cli": { "transport": "acp", "cli": "my-agent-cli" },
    "ollama": { "transport": "api", "endpoint": "http://localhost:11434/v1" },
    "openrouter": {
      "transport": "api",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  },
  "maxTurns": 50,
  "hailMary": {
    "route": "acp",
    "model": "cli-model",
    "provider": "my-cli"
  }
}
~~~

Replace the example model, provider, and CLI values with ones supported by your setup. API credentials belong in the local secret directory and are referenced by the apiKeyEnv field; see [Provider Authentication](/abtars/pi-auth).

## Route selection

Use /route to view or select a configured route:

~~~text
/route
/route pi-ai
/route acp
~~~

After changing the route, use /reset to apply the new transport. Route-specific model assignments and fallback lists are kept separately.

## Fallbacks

Each route can have an ordered fallbacks list. It is used for boot-time model selection, the ACP route's try-next-model loop, and operator display — not for Pi dispatch. A Pi conversation always uses its single configured model; when it fails, the failure is classified once, observed in the durable availability memo, and surfaced as a typed terminal error instead of an in-turn model switch. Pi supplies API provider execution; abTARS owns the configured selection and availability admission.

## Emergency route

The hailMary setting describes an ACP provider used by /emergency. It is a separate ACP execution path and does not use the active pi-ai route.

## Health policy

The retired `healthPolicy` object is accepted but inert: provider health buckets, rotation, and automatic demotion no longer exist. Availability is tracked in the durable memo (`provider-availability-v1.json` under the abtars state dir); see [Resilience](/abtars/resilience). Defaults are applied when fields are omitted. See the configuration shipped with your installation for the current defaults.

## Switching models

Use /model to inspect and change model assignments. A route switch changes the active route; a model change updates the assignment for the selected agent and route.
