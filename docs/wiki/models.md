# Model and Route Management

Model assignments and provider settings are stored in the route-based transport configuration. See [Transport Configuration](./transport.md) for its structure.

## Inspect models and providers

~~~text
/models
/models list
/models list <provider>
/model doctor
~~~

The list commands show configured providers and their available models. The doctor command checks models used by the main agent's current provider and reports provider or authentication problems.

## Change a model

~~~text
/models quick <model>
/models change
/model provider <provider>
~~~

The quick command changes the main agent's model on its current provider. The interactive four-stage picker is available in Telegram. The provider command switches the active route's agents to a configured provider when that provider has model defaults.

For a route or model change that requires a new transport session, use /reset.

## Restore configuration

| Command | Effect |
|---------|--------|
| /models restore | Restore the previous transport configuration |
| /models default | Restore the shipped default transport configuration |
| /models health reset | Clear model health penalties |

## Provider and model configuration

The pi-ai route uses Pi for API model execution. Provider entries, route assignments, fallback candidates, and model metadata are configured separately. Use [Add a Custom API Provider](./custom-pi-providers.md) to add a provider or model, and [Provider Authentication](./pi-auth.md) to choose how it authenticates.

ACP-compatible command-line agents are configured on the ACP route and use their own CLI authentication.
