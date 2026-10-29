# Compatibility Notes

abTARS can connect to messaging platforms, model providers, and optional integrations. The available behavior depends on which route and components you configure.

## Routes

- The pi-ai route uses Pi for API model requests and requires a compatible Pi installation.
- The ACP route connects to an ACP-compatible agent CLI and does not require Pi.
- The optional local terminal interface is available separately from the model route.

See [Transport Configuration](/abtars/transport) and [Pi Integration](/abtars/pi).

## Optional memory

abmind is a separate product. Install and configure it when you want persistent memory; abTARS can run without it. See the [abmind project](https://github.com/aksika/abmind) for its setup and operation.

## Supervision and recovery

In daemon mode, abTARS has a three-layer supervision design. The bridge heartbeat, external watchdog, and operating-system service manager have separate roles. See [Process Supervision](/abtars/supervision) and [Resilience](/abtars/resilience) for the current behavior.

## Platform and provider setup

Telegram and Discord are supported messaging interfaces. Provider availability, authentication, model limits, and pricing are determined by the provider and its current configuration. Check the [installation guide](/abtars/install) and [provider pages](/abtars/pi-providers) before choosing a setup.
