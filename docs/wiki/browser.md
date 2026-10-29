# Browser Agent

Browsie is the managed web-browsing capability. When enabled, the agent can
navigate websites, extract content, and fill forms using the external `cloak`
CLI backed by CloakBrowser's stealth Chromium runtime.

## How it works

- Abtars does not ship or manage a browser binary or browser wrapper.
- The external `cloak` executable and CloakBrowser runtime are installed separately and available on PATH.
- Abtars provides task dispatch: a B-type Kanban card with a detailed goal (via `kanban_manage` or `abtars kanban create`) is created for the Browsie agent — see `templates/skills/browser/SKILL.md`.
- The Browsie agent calls `cloak` directly via shell.

## Requirements

- `cloak` CLI on PATH (install with `abtars deps install cloak`)

## Usage

The agent uses the browser tool automatically when asked to look something up, check a website, or interact with a web page. No special command needed — just ask naturally.
