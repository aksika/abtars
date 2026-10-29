# Add a Custom API Provider

This guide adds an API provider to abTARS. Use the provider's current API documentation for its endpoint, model IDs, limits, and authentication requirements.

## Configure the provider

Add an entry to providers in ~/.abtars/config/transport.json. apiKeyEnv names the credential stored locally; do not put the key value in this file.

~~~json
{
  "providers": {
    "my-provider": {
      "transport": "api",
      "endpoint": "https://api.example.com/v1",
      "apiKeyEnv": "MY_PROVIDER_API_KEY"
    }
  }
}
~~~

Add the credential as ~/.abtars/secret/MY_PROVIDER_API_KEY and set restrictive file permissions. See [Provider Credentials](/abtars/secrets).

If Pi should manage the provider's authentication, configure that provider in Pi and use authSource: pi without apiKeyEnv. See [Provider Authentication](/abtars/pi-auth).

## Add model metadata

Add the provider's model to ~/.abtars/config/models.json. Use values published by the provider and the exact model ID expected by its API.

~~~json
{
  "my-provider/model-name": {
    "contextWindow": 128000,
    "maxOutput": 8192,
    "rank": 1,
    "cost": { "input": 1.0, "output": 2.0 },
    "transports": ["my-provider"]
  }
}
~~~

Replace the sample context, output, cost, and model values with current provider information. If the model is already in the catalog, add my-provider to its transports list instead of duplicating the entry.

## Assign and verify

Assign the provider and model to an agent in the pi-ai route of transport.json. Then run:

~~~bash
abtars restart --cold
abtars doctor
abtars status
~~~

Use /model to inspect the active assignment. If Pi cannot resolve the provider or model, check the provider's Pi compatibility and configuration.
