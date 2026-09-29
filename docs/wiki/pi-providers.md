# API Providers with Pi

The pi-ai execution route uses Pi's agent core and provider engine for API model requests. In transport.json, providers on this route use transport: api.

## Configure the API route

A transport configuration selects the route and assigns a model and provider to each agent. Replace the example model and provider names with entries supported by your installation.

~~~json
{
  "schemaVersion": 3,
  "activeRoute": "pi-ai",
  "routes": {
    "pi-ai": {
      "agents": {
        "main": { "model": "provider/model-name", "provider": "my-provider" }
      },
      "fallbacks": []
    }
  },
  "providers": {
    "my-provider": {
      "transport": "api",
      "endpoint": "https://api.example.com/v1",
      "apiKeyEnv": "MY_PROVIDER_API_KEY"
    }
  }
}
~~~

The apiKeyEnv field names the credential entry in abTARS's local secret directory. See [Provider authentication](/abtars/pi-auth).

## What Pi provides

Pi runs the API-route model and tool loop and supplies the provider implementation. The available providers, model metadata, and provider-specific features depend on the compatible Pi installation and provider. Pi's model catalog is read at startup when an API provider is configured; abTARS still owns route assignments, candidate health, and fallback decisions.

Some providers support prompt caching. Availability and usage reporting depend on the provider and model.

## Fallback and ACP

abTARS selects the next configured candidate when a request fails according to its provider health and fallback policy.

The ACP route runs a compatible agent CLI separately and does not require Pi. The /emergency path also uses ACP when it is configured.

## Requirements

- A compatible Pi installation for the pi-ai route and Pi coding features. The standard installer manages Pi; use abtars deps install pi to install or repair it.
- An ACP-compatible CLI for the ACP route.

See [Transport Configuration](/abtars/transport) and [Provider Authentication](/abtars/pi-auth) for the related settings.
