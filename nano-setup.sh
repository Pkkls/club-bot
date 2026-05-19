#!/bin/bash
# Run once on the LicheeRV Nano to set up everything.
# Usage: bash nano-setup.sh

set -e

REPO_URL="https://github.com/Pkkls/club-bot.git"
INSTALL_DIR="$HOME/club-bot"

echo "=== club-bot Nano setup ==="

# 1. Clone repo
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[setup] repo already cloned — pulling latest"
  cd "$INSTALL_DIR" && git pull --ff-only origin master
else
  echo "[setup] cloning repo..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 2. Install deps
echo "[setup] npm install..."
npm install --production

# 3. Make start.sh executable
chmod +x "$INSTALL_DIR/start.sh"

# 4. Create .env file if missing
if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo "[setup] creating .env — fill in your keys"
  cat > "$INSTALL_DIR/.env" << 'EOF'
GROQ_API_KEY=YOUR_GROQ_KEY
TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_TELEGRAM_CHAT_ID
CLUB_EMAIL=YOUR_CLUB_EMAIL
CLUB_PASSWORD=YOUR_CLUB_PASSWORD
EOF
  echo "[setup] ⚠️  Edit $INSTALL_DIR/.env with your real keys before running"
fi

# 5. Load .env helper in bashrc (if not already there)
if ! grep -q "club-bot/.env" "$HOME/.bashrc" 2>/dev/null; then
  echo "" >> "$HOME/.bashrc"
  echo "# club-bot env" >> "$HOME/.bashrc"
  echo "set -a && source $INSTALL_DIR/.env && set +a 2>/dev/null || true" >> "$HOME/.bashrc"
fi

# 6. Install crontab
# Runs every 2h between 15h-23h UTC (= 11h-19h ET, Tyler's active window)
CRON_CMD="0 15,17,19,21,23 * * * cd $INSTALL_DIR && bash start.sh"
( crontab -l 2>/dev/null | grep -v "club-bot"; echo "$CRON_CMD" ) | crontab -

echo ""
echo "=== Setup complete ==="
echo ""
echo "Crontab installed:"
crontab -l | grep club-bot
echo ""
echo "Next steps:"
echo "  1. Edit $INSTALL_DIR/.env with your real keys"
echo "  2. Copy cookies from PC:  scp cookies_cxfan.json user@nano-ip:$INSTALL_DIR/"
echo "  3. Test manually:         cd $INSTALL_DIR && bash start.sh"
echo ""
echo "To view logs: tail -f $INSTALL_DIR/logs/bot.log"
