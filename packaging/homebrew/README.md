# Homebrew Tap

## For users

```bash
brew tap aksika/abtars
brew install abtars abmind
```

## Setup (tap repo maintainer)

1. Create repo `aksika/homebrew-abtars` on GitHub
2. Copy formulas to `Formula/abtars.rb` and `Formula/abmind.rb`
3. Update `sha256` with actual tarball hash:
   ```bash
   curl -sL https://registry.npmjs.org/abtars/-/abtars-<version>.tgz | shasum -a 256
   curl -sL https://registry.npmjs.org/abmind/-/abmind-<version>.tgz | shasum -a 256
   ```

## Automation

The release workflow (#1103) auto-updates the tap after each `npm publish`:
- Computes SHA256 of the published tarball
- Pushes updated formula to `aksika/homebrew-abtars`
- Requires `HOMEBREW_TAP_TOKEN` secret (classic PAT with `repo` scope)
