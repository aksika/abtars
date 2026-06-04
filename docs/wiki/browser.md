# Browser Agent

Browsie is the built-in web browsing capability. When enabled, the agent can navigate websites, extract content, and fill forms.

## Enable

Set in `.env`:
```
BROWSER_ENABLED=true
```

## Requirements

- Playwright (installed automatically as optional dependency)
- Chromium (downloaded on first use by Playwright)

## What the agent can do

- Navigate to URLs
- Extract page text (with character limit)
- Click elements, fill forms
- Take screenshots
- Wait for page load / dynamic content

## Configuration

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_SESSION_TIMEOUT_MS` | 300000 | Session auto-close after inactivity |
| `BROWSER_MAX_SESSIONS` | 3 | Max concurrent browser sessions |
| `WEB_SCRAPE_USER_AGENT` | (default Chrome UA) | Custom user agent string |

## Usage

The agent uses the browser tool automatically when asked to look something up, check a website, or interact with a web page. No special command needed — just ask naturally.
