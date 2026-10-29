# Multi-User

abTARS supports multiple configured users with role-based access and per-user tool and platform settings.

## Configuration

Define users in ~/.abtars/config/users.json:

~~~json
{
  "users": [
    {
      "userId": "owner",
      "role": "master",
      "maxClass": 3,
      "tools": ["all"],
      "platforms": { "telegram": 123456789 }
    },
    {
      "userId": "friend",
      "role": "user",
      "maxClass": 1,
      "tools": ["memory_recall"],
      "platforms": { "telegram": 987654321 },
      "languages": ["en"]
    }
  ]
}
~~~

Replace the sample IDs and names with your own values.

## Roles

| Role | Typical access |
|------|----------------|
| master | Administrative commands and configured tools |
| user | Chat, supported user commands, and configured tools |
| guest | Limited chat access |

The exact permissions depend on the command, platform, and per-user configuration.

## Memory classes

When memory integration is enabled, maxClass sets the highest memory class a user may access. Class labels and handling are defined by the installed memory system.

## User administration

The /users command lists and manages configured users. Available subcommands depend on the caller's role; use /help for the current command syntax.

A user can have separate platform IDs for Telegram and Discord.
