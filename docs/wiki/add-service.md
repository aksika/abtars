# Add a Service

This guide shows the main steps for connecting an external service, using Home Assistant as an example.

## 1. Add configuration

Place non-secret settings in ~/.abtars/config/.env.skills:

~~~bash
HA_URL=http://home-assistant.local:8123
~~~

Store credentials separately in the local secret directory. Do not add API tokens to skills, scripts, or configuration files.

~~~bash
read -rsp "Home Assistant token: " ha_token
printf '%s' "$ha_token" > ~/.abtars/secret/HA_TOKEN
unset ha_token
chmod 600 ~/.abtars/secret/HA_TOKEN
~~~

A new process is needed to load changed credentials. Run abtars restart --cold.

## 2. Write a skill

A skill gives the agent instructions for using the service. Create a Markdown file under ~/.abtars/skills/self/:

~~~markdown
# Home Assistant

Use the Home Assistant REST API for the user's requested smart-home actions.

## Configuration
- Service URL: HA_URL
- Access token: HA_TOKEN

## Rules
- Confirm before actions with significant effects.
- Report the result of each action.
- If the service is unavailable, tell the user.
~~~

Keep skills narrow, review any commands they can run, and avoid embedding credentials in the file.

## 3. Add a script tool if needed

A script can make a repeated integration easier to operate. Keep credentials out of the script and read them from the process environment only when the integration requires that interface.

## Verify

Run abtars doctor and check the latest bridge log. If you use the key in an API provider, reference its name with apiKeyEnv in transport.json.
