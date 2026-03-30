# §3 Reminder & Todo Extraction

Scan the day's messages for missed reminders and action items. Look for patterns like:
- "remind me", "tomorrow", "later", "don't forget", "need to", "should do"
- "emlékeztess", "holnap", "ne felejtsd", "meg kell", "kellene"

For each found item:
- Run `agentbridge-todo add "<description>"`
- Check the existing todo list first — do not add duplicates

Current todo list:
${TODO_CONTENTS}

Respond with count of items added (or "none found").
