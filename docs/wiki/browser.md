# Browser Agent

Browsie is the built-in web browsing capability. When enabled, the agent can navigate websites, extract content, and fill forms using the external `cloakbrowser` CLI.

## How it works

- Abtars does not ship or manage a browser binary.
- The external `cloakbrowser` executable must be installed separately and available on PATH.
- Abtars provides task dispatch: `abtars-browse` creates a B-type Kanban card for the Browsie agent.
- The Browsie agent calls `cloakbrowser` directly via shell.

## Requirements

- `cloakbrowser` CLI on PATH (installed separately)

## Usage

The agent uses the browser tool automatically when asked to look something up, check a website, or interact with a web page. No special command needed — just ask naturally.
