#!/usr/bin/env bash
set -uo pipefail
PROJECT_DIR=/Users/akos/agentbridge
AB_HOME=/Users/akos/.agentbridge
mkdir -p ~/.local/bin "$AB_HOME/scripts"

# Launcher
cp "$PROJECT_DIR/scripts/agentbridge.sh" "$AB_HOME/agentbridge.sh"
chmod +x "$AB_HOME/agentbridge.sh"
sed -i '' "s|^PROJECT_DIR=.*|PROJECT_DIR=\"$PROJECT_DIR\"|" "$AB_HOME/agentbridge.sh"

# Browser docker
sed -i '' "s|^PROJECT_DIR=.*|PROJECT_DIR=\"$PROJECT_DIR\"|" "$AB_HOME/browser-docker.sh" 2>/dev/null

# Scripts
cp "$PROJECT_DIR/scripts/daily-backup.sh" "$AB_HOME/scripts/daily-backup.sh" 2>/dev/null
cp "$PROJECT_DIR/scripts/doctor.sh" "$AB_HOME/scripts/doctor.sh" 2>/dev/null
chmod +x "$AB_HOME/scripts/"*.sh 2>/dev/null

# CLI wrappers
for cli in recall store sleep browser browse todo cron expand; do
  SCRIPT="$AB_HOME/agentbridge-$cli"
  printf '#!/usr/bin/env bash\nexec node "%s/dist/cli/agentbridge-%s.js" "$@"\n' "$PROJECT_DIR" "$cli" > "$SCRIPT"
  chmod +x "$SCRIPT"
  ln -sf "$SCRIPT" ~/.local/bin/agentbridge-$cli
done

echo "✅ CLIs deployed:"
ls ~/.local/bin/agentbridge-*
