# Provider Credentials

Store API keys and other provider credentials in abTARS's local secret directory. In provider configuration, apiKeyEnv names the matching credential entry. Raw credential values do not belong in transport.json or source control.

## Add an API key

Use the environment-variable name configured for the provider. This example prompts without displaying the key:

~~~bash
read -rsp "API key: " api_key
printf '%s' "$api_key" > ~/.abtars/secret/EXAMPLE_API_KEY
unset api_key
chmod 600 ~/.abtars/secret/EXAMPLE_API_KEY
abtars restart --cold
~~~

Replace EXAMPLE_API_KEY with the name used by the provider's apiKeyEnv setting. The cold restart starts a new process so it can load the updated credential.

## Reference the key

A provider entry names the credential without containing its value:

~~~json
{
  "providers": {
    "example": {
      "transport": "api",
      "endpoint": "https://api.example.com/v1",
      "apiKeyEnv": "EXAMPLE_API_KEY"
    }
  }
}
~~~

Check that apiKeyEnv matches the local credential name exactly. abTARS rejects raw credential fields in transport.json.

For providers authenticated through Pi, configure Pi's own authentication and set authSource to pi on the provider entry. Do not combine Pi-managed auth with apiKeyEnv. See [Provider Authentication](/abtars/pi-auth).

## Check configuration

Run abtars doctor and inspect abtars status to confirm the provider is ready. If a credential has been exposed in logs, shell history, a repository, or an issue, revoke it with the provider and create a replacement.
