"""
Club.com fan bot — main entry point.

Usage:
  python main.py --follow                     # follow target creators
  python main.py --engage                     # comment session on all targets
  python main.py --engage --creator bijan     # comment on specific creator
  python main.py --dry-run --engage           # simulate without posting
  python main.py --check                      # verify auth + print own profile
"""
import argparse
import logging
import sys
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
# Edit these to set your targets
TARGET_CREATORS = [
    "bijan",
    "henrik",
    "eddie",
]

FOLLOW_ON_START = True       # follow targets on --follow
COMMENTS_PER_SESSION = 1     # comments per creator per --engage run


# ── Logging setup ─────────────────────────────────────────────────────────────
Path("logs").mkdir(exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s — %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("logs/bot.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("main")


def cmd_check():
    import club_api as api
    me = api.get_me()
    log.info("logged in as: %s (id=%s)", me.get("username"), me.get("id"))
    log.info("platformRoles: %s", me.get("platformRoles"))
    log.info("followingCount: %s", me.get("followingCount"))
    api.close_browser()


def cmd_follow(dry_run: bool):
    from actions import run_follow_creators
    log.info("following %d creators", len(TARGET_CREATORS))
    run_follow_creators(TARGET_CREATORS, dry_run=dry_run)


def cmd_engage(creator: str | None, dry_run: bool):
    from actions import run_engagement_session
    targets = [creator] if creator else TARGET_CREATORS
    log.info("engagement session on %s", targets)
    run_engagement_session(targets, comments_per_creator=COMMENTS_PER_SESSION, dry_run=dry_run)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--check", action="store_true", help="Verify auth")
    p.add_argument("--follow", action="store_true", help="Follow target creators")
    p.add_argument("--engage", action="store_true", help="Comment session")
    p.add_argument("--creator", default=None, help="Single creator target")
    p.add_argument("--dry-run", action="store_true", help="Simulate without posting")
    args = p.parse_args()

    dry = args.dry_run
    if dry:
        log.info("DRY RUN MODE — no real actions")

    if args.check:
        cmd_check()
    elif args.follow:
        cmd_follow(dry_run=dry)
    elif args.engage:
        cmd_engage(args.creator, dry_run=dry)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
