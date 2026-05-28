# Multi-User

abTARS supports multiple users with role-based access control.

## Configuration

Define users in `~/.abtars/config/users.json`:

```json
{
  "users": [
    {
      "userId": "master",
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
      "languages": ["en", "hu"]
    }
  ]
}
```

## Roles

| Role | Permissions |
|------|------------|
| `master` | Full access — all commands, all tools, all memory classes |
| `user` | Can chat, limited commands (`/new`, `/reset`, `/stop`, `/status`, `/help`), configured tools only |
| `guest` | Can chat only, no memory recording, no tools |

## Memory Classification

| Class | Label | Who can access |
|-------|-------|---------------|
| 0 | UNCLASSIFIED | Everyone |
| 1 | RESTRICTED | user + master |
| 2 | CONFIDENTIAL | master only |
| 3 | SECRET | master only, encrypted at rest |

## Approving Users

From chat:
```
/users                    → list all users
/users approve <id>       → approve by platform ID (adds as guest)
/users revoke <userId>    → remove access
```

## Platform ID Mapping

Each user maps to platform-specific IDs:

```json
"platforms": {
  "telegram": 123456789,
  "discord": "987654321098765432"
}
```

A user can be on multiple platforms — same memory, same role, different platform IDs.
