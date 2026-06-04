# Homebrew Tap

To publish:

1. Create repo `aksika/homebrew-abtars` on GitHub
2. Copy `abtars.rb` to `Formula/abtars.rb` in that repo
3. Update `sha256` with actual tarball hash: `curl -sL <url> | shasum -a 256`
4. Users install with:

```bash
brew tap aksika/abtars
brew install abtars
```

On each release:
- Update `url` to new version tarball
- Update `sha256`
- Push to tap repo
