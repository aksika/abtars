---
name: topic-save
description: Save, update, and manage topic-specific knowledge files from conversation discussions
user-invocable: true
---

# Topic Save Skill

You can save topic-specific knowledge from the current conversation into persistent markdown files. Use your native file tools (read file, write file, list directory) to create and update topic files — no CLI commands needed.

## Purpose

This skill saves and updates topic-specific knowledge files in `.agentbridge/topics/`. When the user asks to save a topic, you condense the relevant discussion from the current conversation into a structured markdown summary and write it to a topic file. If a file for that topic already exists, you append the new content to it instead of creating a duplicate.

## How to invoke

Follow these steps using your native file tools (read, write, list directory). Do NOT use shell commands.

### Step 1: Sanitize the TopicName

Apply these rules in order to convert the user's topic name into a safe filename component:

1. Replace all whitespace characters (spaces, tabs, newlines) with hyphens (`-`)
2. Remove any characters that are not alphanumeric, hyphens, or underscores
3. Collapse consecutive hyphens into a single hyphen
4. Trim leading and trailing hyphens
5. If the result is empty, stop and tell the user a valid topic name is required
6. If the result contains `..` or starts with `/`, stop and tell the user the topic name is invalid (path traversal rejected)
7. Preserve the original casing of the input (do not lowercase)

**Examples:**

| Input | Sanitized | Notes |
|-------|-----------|-------|
| `Tesla` | `Tesla` | No change needed |
| `My Tesla Project` | `My-Tesla-Project` | Spaces → hyphens |
| `hello world\ttab` | `hello-world-tab` | All whitespace → hyphens |
| `test!!!name` | `testname` | Non-alphanumeric removed |
| `My--Topic` | `My-Topic` | Consecutive hyphens collapsed |
| `Already-Valid_Name` | `Already-Valid_Name` | Underscores preserved |
| `../etc/passwd` | **Rejected** | Path traversal detected |
| `   ` | **Rejected** | Empty after sanitization |

### Step 2: Discover existing topic files

1. Use your list directory tool to list all files in `.agentbridge/topics/`
2. Look for a file matching the pattern `{SanitizedName}-*.md` using a **case-insensitive** comparison on the name portion (before the date)
   - For example, if the sanitized name is `Tesla`, then `Tesla-2025-01-15.md`, `tesla-2025-01-15.md`, and `TESLA-2025-07-01.md` all match
3. If multiple files match (unusual), use the one with the most recent date
4. If no match is found, proceed to Step 3a (create new file)
5. If a match is found, proceed to Step 3b (update existing file)

### Step 3a: Create a new topic file

1. Ensure the directory `.agentbridge/topics/` exists. If it does not, create it (including parent directories if needed)
2. Condense all discussion related to the topic from the current conversation into a structured markdown summary (see Topic File Format below)
3. Write the summary to `.agentbridge/topics/{SanitizedName}-{YYYY-MM-DD}.md` where `{YYYY-MM-DD}` is today's date
4. Confirm to the user that the topic was saved

### Step 3b: Update an existing topic file

1. Read the existing topic file
2. Condense the new discussion content from the current conversation
3. Append the new condensed content into or next to the relevant section of the existing file. Merge into existing sections where appropriate
4. Write the updated content back to the **same file** — do NOT change the filename or its date
5. Confirm to the user that the topic was updated

## File naming convention

```
.agentbridge/topics/{SanitizedName}-{YYYY-MM-DD}.md
```

- `{SanitizedName}`: The topic name after applying sanitization rules (original casing preserved)
- `{YYYY-MM-DD}`: The date the file was originally created (ISO 8601 format)
- The date in the filename is set on creation and is NOT updated on append/update operations

## Topic file format

```markdown
# {TopicName}

## Summary
[Condensed summary of the topic discussion]

## Key Points
- [Point 1]
- [Point 2]

## Details
[Expanded details organized by subtopic]
```

Write a condensed summary — not a raw transcript dump. Organize the content so it is useful for future reference.

## When to use

- The user explicitly asks to save a topic: "save this topic Tesla", "save topic on Kubernetes setup", "store this as a topic"
- The user asks to update an existing topic: "add this to the Tesla topic", "update the Kubernetes topic with this"

## When NOT to use

- **Never** on routine conversational messages, greetings, or small talk
- **Never** on short facts, preferences, or decisions that belong in instant-store instead
- **Never** when the user asks to recall or search for topic information — use memory-search instead
- **Never** for housekeeping or compaction — that is a future sleep-cycle responsibility, not this skill

## Error handling

| Condition | What to do |
|-----------|------------|
| TopicName is empty or empty after sanitization | Tell the user a valid topic name is required |
| TopicName contains path traversal (`..` or starts with `/`) | Tell the user the topic name is invalid and was rejected for safety |
| `.agentbridge/topics/` directory cannot be created | Tell the user about the filesystem error |
| Topic file cannot be written or read | Tell the user about the filesystem error |
| User requests update but no existing topic file is found | Tell the user no topic file was found for that name, and offer to create a new one |

## Important constraints

- All file operations MUST target only the `.agentbridge/topics/` directory. Never write topic files anywhere else.
- Use only your native file tools (read file, write file, list directory). Do not use CLI commands.
- The filename date reflects the original creation date. Do not change it on updates.
