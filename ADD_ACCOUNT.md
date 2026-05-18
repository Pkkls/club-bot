# Adding a new account to the bot army

## 1. Create a Club.com account
- Use a Gmail address (Google OAuth login)
- Unique device fingerprint is auto-generated from the account name — no config needed

## 2. Add GitHub Secrets
In your repo → Settings → Secrets → Actions, add:
- `CLUB_EMAIL_<ACCOUNTNAME>` — e.g. `CLUB_EMAIL_BOTACCOUNT2`
- `CLUB_PASSWORD_<ACCOUNTNAME>` — the Google account password

## 3. Add account to matrix in `.github/workflows/bot.yml`
```yaml
matrix:
  account:
    - name: cxfan
      email_secret: CLUB_EMAIL_CXFAN
      password_secret: CLUB_PASSWORD_CXFAN

    # Add new account here:
    - name: botaccount2
      email_secret: CLUB_EMAIL_BOTACCOUNT2
      password_secret: CLUB_PASSWORD_BOTACCOUNT2
```

## 4. Optional: self-hosted runner (strongly recommended)
GitHub Actions runs on datacenter IPs → higher bot detection risk.
Your PC runs on a residential IP → much safer.

To use your PC as the runner:
1. Repo → Settings → Actions → Runners → New self-hosted runner
2. Follow the setup steps (installs a small agent, ~5 min)
3. Set repo variable `USE_SELF_HOSTED` = `true` (Settings → Variables → Actions)

Once set, all bots run locally on your machine with your residential IP.

## Warmup phases (automatic, no action needed)
- Sessions 1-5: **new** — only profile visits, no interaction
- Sessions 6-20: **warming** — follows only (~35% of creators)
- Sessions 21+: **active** — full engagement (follow + comment + like)

Each account progresses independently. State is saved between runs via GitHub Actions cache.
