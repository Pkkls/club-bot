#!/bin/bash
# LicheeRV Nano — club-bot runner
# Pulls latest code from GitHub then runs the bot.
# Called by cron — never touch this file manually.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/bot.log"
MAX_LOG_LINES=2000

cd "$SCRIPT_DIR"
mkdir -p "$LOG_DIR"

echo "" >> "$LOG_FILE"
echo "===== $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG_FILE"

# 1. Pull latest code
echo "[start] git pull..." >> "$LOG_FILE"
git pull --ff-only origin master >> "$LOG_FILE" 2>&1 || echo "[start] git pull failed — continuing with current version" >> "$LOG_FILE"

# 2. Install new deps if package.json changed
echo "[start] npm install..." >> "$LOG_FILE"
npm install --production --silent >> "$LOG_FILE" 2>&1 || true

# 3. Run bot
echo "[start] node bot.js" >> "$LOG_FILE"
node bot.js >> "$LOG_FILE" 2>&1

# 4. Trim log file to last MAX_LOG_LINES lines
tail -n "$MAX_LOG_LINES" "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
