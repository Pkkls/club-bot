# Deployment — LicheeRV Nano (192.168.1.46)

## Quick SSH
```bash
wsl bash -c "ssh -i ~/.ssh/nano_key root@192.168.1.46 'COMMAND'"
```

## Auto-Monitoring
**Watchdog:** runs daily at 6 AM via crond
- Checks process status, disk usage
- Logs to `/root/watchdog.log`

## Commands
```bash
wsl bash -c "ssh -i ~/.ssh/nano_key root@192.168.1.46 ls -lah /root"
wsl bash -c "ssh -i ~/.ssh/nano_key root@192.168.1.46 tail -f /root/watchdog.log"
```

## Directory Structure
- `/root/club-bot/` — Main project
- `/root/watchdog.sh` — Health check script
- `/opt/pkkls_bot.py` — Telegram bot (always running)

## SSH Details
- Host: 192.168.1.46
- User: root (key-only)
- Key: `~/.ssh/nano_key` (WSL, chmod 600)
