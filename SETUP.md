# club-bot — cxfan

Bot autonome qui poste des commentaires sur club.com en se faisant passer pour Tyler, 23 ans, Columbus OH, fan CX/IcePoseidon depuis 2019.

---

## Architecture

```
bot.js          — orchestrateur principal, pipeline complet
session.js      — gestion cookies / auth club.com
persona.js      — probabilités d'activité, budget commentaires, fenêtres horaires
creators.js     — tracking créateurs, prioritisation, trending
metrics.js      — suivi qualité commentaires
telegram.js     — notifications + commandes admin
do-login.js     — re-login manuel via Puppeteer (PC uniquement)
send-history.js — envoie l'historique des commentaires sur Telegram
```

---

## Persona — Tyler

- 23 ans, Columbus OH, Amazon warehouse (6h–14h30 ET)
- Fan IcePoseidon / CX crew depuis 2019 : KangJoel, SJC, Tazo, ABZ, Ac7onman, ChickenAndy, SHoovy, EBZ, SamPepper, Taemin, Xenathewitch, NickWhite, BurgerPlanet, MANDO, Nanatty, NickLee, Suspendas
- Regarde aussi Kick : CS2, FPS, variety
- Ton : plat, légèrement paranoïaque, observe les détails, n'écrit que si il a quelque chose de spécifique à dire

---

## Pipeline de commentaire (par post)

```
1. Timing filter       — skip si post < 20min ou > 3h (évolution #4)
2. analyzePost()       — Prompt 1 : extrait cx_relevant, has_hook, content_type, farming_signal (JSON)
3. shouldCommentOnPost() — Prompt 2 : score 0–10, seuil = 6 (évolution #7)
4. generateComment()   — génère le commentaire avec contexte de l'analyse
5. juryVote()          — 3 jurés parallèles (linguiste, sociologue, paranoïaque) — 2/3 KEEP requis (évolution #1)
6. verifyComment()     — vérification finale : KEEP ou DELETE
7. POST → si DELETE à l'étape 5 ou 6 → supprime le commentaire via API
```

---

## Cooldowns adaptatifs (timezone ET)

| Heure ET | Multiplicateur |
|---|---|
| 15h–22h (peak) | ×0.45 |
| 12h–15h / 22h+ | ×0.75 |
| 8h–12h | ×1.0 |
| 0h–8h (nuit) | ×1.8 |

La fonction `pace(a, b)` dans bot.js remplace `rand(a, b)` pour tous les sleeps.

---

## Variables d'environnement requises

```
GROQ_API_KEY          — clé Groq (llama-3.3-70b-versatile)
TELEGRAM_BOT_TOKEN    — token bot Telegram
TELEGRAM_CHAT_ID      — chat ID Telegram (notifications admin)
CLUB_EMAIL            — email compte club.com (Google OAuth)
CLUB_PASSWORD         — mot de passe Google
```

Copier `run-bot.example.cmd` → `run-bot.cmd` et remplir les valeurs.

---

## Fichiers runtime (non versionnés, à créer localement)

| Fichier | Contenu |
|---|---|
| `cookies_cxfan.json` | Session club.com (6 cookies Puppeteer) |
| `state_cxfan.json` | Posts déjà commentés, follows, likes |
| `history_cxfan.json` | Historique commentaires + follows |

---

## Installation

```bash
npm install
```

Dépendances principales : `groq-sdk`, `puppeteer-extra`, `puppeteer-extra-plugin-stealth`, `puppeteer-extra-plugin-anonymize-ua`

---

## Première mise en route

### 1. Obtenir les cookies (PC Windows uniquement — Google OAuth)

```bash
node do-login.js
```

- Ouvre Chrome, va sur club.com
- Clique "Log in" → Google → connecte-toi manuellement
- Le script détecte `chatAuthToken` et sauvegarde `cookies_cxfan.json` automatiquement
- Timeout 10 minutes

### 2. Tester

```bash
# Avec FORCE_SESSION=1 pour bypass les fenêtres d'activité et le budget
set FORCE_SESSION=1 && node bot.js
```

### 3. Voir l'historique

```bash
node bot.js --history
```

### 4. Envoyer l'historique sur Telegram

```bash
node send-history.js
```

---

## Déploiement LicheeRV Nano (Linux riscv64)

Le bot tourne entièrement via API HTTPS — pas de navigateur nécessaire en fonctionnement normal.

### Installer Node.js sur le Nano

```bash
# Vérifier l'archi
uname -m   # doit retourner riscv64

# Télécharger Node.js 20 riscv64
wget https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-riscv64.tar.xz
tar -xf node-v20.19.0-linux-riscv64.tar.xz
sudo cp -r node-v20.19.0-linux-riscv64/{bin,lib,include,share} /usr/local/

node --version   # v20.x.x
```

> Si le binaire officiel ne tourne pas sur cette distrib, compiler depuis les sources :
> `./configure --dest-cpu=riscv64 && make -j2` (long mais fonctionnel)

### Cloner et installer

```bash
git clone https://github.com/Pkkls/club-bot.git
cd club-bot
npm install
```

### Copier les fichiers runtime depuis le PC

```bash
# Depuis le PC (PowerShell ou cmd)
scp cookies_cxfan.json user@nano-ip:/path/to/club-bot/
```

### Configurer les variables d'environnement

```bash
# /etc/environment ou ~/.bashrc
export GROQ_API_KEY=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
export CLUB_EMAIL=...
export CLUB_PASSWORD=...
```

### Lancer via cron

```bash
crontab -e
# Exemple : toutes les 3h entre 15h et 23h ET (= 19h–3h UTC)
0 19,22,1 * * * cd /path/to/club-bot && node bot.js >> logs/bot.log 2>&1
```

---

## Session expirée (cookies invalides)

Le bot détecte automatiquement les cookies expirés :
1. Envoie une alerte Telegram : *"⚠️ session expirée — lance `node do-login.js` sur ton PC"*
2. S'arrête proprement (exit 0)

**Pour renouveler :**
1. Sur le PC Windows : `node do-login.js` → se connecter manuellement
2. Copier `cookies_cxfan.json` sur le Nano via `scp`
3. Le bot repart au prochain run

---

## Commandes Telegram admin

Envoyer dans le chat Telegram :
- `/status` — état du bot, commentaires du jour
- `/history` — derniers commentaires
- `/pause` — mettre en pause
- `/resume` — reprendre

---

## Sécurité anti-ban

- Pas d'API officielle X/club — appels GraphQL internes avec cookies session
- Intervalles aléatoires entre actions (fonction `pace()` timezone-aware)
- Activité humaine simulée : likes silencieux, visites profil, parfois suit sans commenter
- Budget commentaires : 1–3/jour max, probabiliste
- Double vérification IA avant de garder un commentaire (jury + verify)
- Jamais de mots bannis : "w", "L", "facts", "bro", "fire", "ngl", "based", etc.

---

## Variables optionnelles

```
FORCE_SESSION=1   — bypass fenêtre d'activité ET budget (tests uniquement)
```

---

## Modèle IA

Groq `llama-3.3-70b-versatile` — 5 appels par commentaire posté :
1. `analyzePost` — analyse du post
2. `shouldCommentOnPost` — score 0–10
3. `generateComment` — génération
4. `juryVote` × 3 (parallèles) — validation
5. `verifyComment` — vérification finale
