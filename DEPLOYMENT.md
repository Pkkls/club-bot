# Deployment — LicheeRV Nano (192.168.1.46)

Bot hébergé sur un LicheeRV Nano (RISC-V, busybox). SSH par clé uniquement.

## Accès SSH

La clé vit dans WSL. Pour toute commande non-triviale (variables, pipes,
multi-ligne), passer le script par **stdin** — `wsl.exe` casse le quoting inline :

```bash
printf '%s' 'COMMANDE' | wsl bash -c "ssh -i ~/.ssh/nano_key root@192.168.1.46 sh -s"
```

## Services (état 2026-05-20)

| Service | Statut |
|---------|--------|
| `python3 /opt/pkkls_bot.py` (bot Telegram) | Running |
| club-bot Node.js (`/root/club-bot/`) | Stoppé, démarrage manuel |
| `crond` | **Zombie** (SIGSEGV C906) — ne déclenche plus rien |

⚠️ **Ne rien planifier via crond** : il est mort. Un scheduler maison
`/etc/init.d/S82club_bot` gère le club-bot. Le reste de la planification
(ex. backups) vit côté PC.

## Backups

L'état runtime + secrets (`.env`, `auth.json`, `cookies/state/history_cxfan.json`,
etc.) est sauvegardé chiffré dans le repo privé **`Pkkls/nano-backups`**
(AES-256, tâche Windows quotidienne). Le code lui-même est ici (`Pkkls/club-bot`).

Restauration testée (round-trip sha256 OK) : voir `Pkkls/nano-backups/README.md`.

## Contraintes nano

- Pas de `git`, pas de `opkg`. Tout push GitHub se fait depuis le PC.
- busybox `tar` n'a pas `-z` → `tar -cf - | gzip`.
- Outils dispo : openssl, tar, gzip, base64, sha256sum.
