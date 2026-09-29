# Pi Integration

abTARS uses [Pi](https://github.com/earendil-works/pi) as its API model engine
and coding runtime. Pi's agent core runs the model and tool loop on the API
route, and Pi's provider engine connects that route to model providers.

abTARS supplies the surrounding agent service: messaging, session lifecycle,
tool permissions, task tracking, provider selection and fallback, and delivery
of results. Pi is installed separately and discovered at runtime; it is not
bundled into abmind.

## Routes

- **API route:** Uses Pi's agent core and provider engine. A compatible Pi
  installation is required.
- **ACP route:** Connects to an ACP-compatible agent CLI and does not require or
  load Pi.

The standard installer sets up Pi for the API route. You can manage the Pi
installation with **abtars deps install pi** and **abtars deps update pi**.

## Pi features

- **Model providers:** Use the providers supported by Pi, with abTARS managing
  candidate selection, health, and fallback.
- **Terminal interface:** Run **abtars tui** to use abTARS from a local terminal.
- **Coding work:** Start supervised Pi coding runs in configured workspaces.
  Runs are tracked and reconciled by abTARS.

Pi is pinned to the tested 0.85.x line. The current pin is recorded in
PI_COMPATIBILITY and mirrored in the development dependencies. abTARS warns
when it finds a newer Pi minor line so you can return to the tested version.

Related guides:

- [TUI](/abtars/pi-tui)
- [Pi providers](/abtars/pi-providers)
- [Provider authentication](/abtars/pi-auth)
- [Custom providers](/abtars/custom-pi-providers)
- [Pi coding executor](/abtars/pi-executor)
