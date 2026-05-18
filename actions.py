"""
High-level bot actions: comment run, follow run, engagement run.
"""
import random
import logging
import json
from pathlib import Path

import club_api as api
from content_gen import get_comment

log = logging.getLogger("actions")
STATE_FILE = Path("logs/state.json")


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"commented": [], "followed": [], "visited": []}


def save_state(state: dict):
    STATE_FILE.parent.mkdir(exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def run_comment_on_creator(username: str, n_posts: int = 2, dry_run: bool = False):
    state = load_state()
    user = api.get_user(username)
    creator_id = user.get("id")
    log.info("targeting %s (id=%s)", username, creator_id)

    posts = api.get_creator_posts(username, limit=10)
    if not posts:
        log.warning("no posts for %s", username)
        return

    posts = [p for p in posts if p["id"] not in state["commented"]][:n_posts]

    for post in posts:
        post_id = post["id"]
        caption = post.get("caption", "") or ""
        content_type = post.get("contentType", "text")
        comment = get_comment(caption, content_type)
        log.info("commenting on %s: %r", post_id, comment)

        if not dry_run:
            api.human_delay(2, 6)
            try:
                api.post_comment(post_id, comment)
                state["commented"].append(post_id)
                log.info("✓ commented")
            except Exception as e:
                log.error("comment failed: %s", e)
        else:
            log.info("[dry-run] would comment: %r", comment)
            state["commented"].append(post_id)

        api.human_delay(3, 8)

    save_state(state)


def run_follow_creators(usernames: list[str], dry_run: bool = False):
    state = load_state()
    for username in usernames:
        if username in state["followed"]:
            log.info("already followed %s, skipping", username)
            continue
        try:
            user = api.get_user(username)
            user_id = user.get("id")
            if not user_id:
                log.warning("no id for %s", username)
                continue
            log.info("following %s (id=%s)", username, user_id)
            if not dry_run:
                api.human_delay(1, 4)
                result = api.follow_user(user_id)
                log.info("follow result: %s", result)
            else:
                log.info("[dry-run] would follow %s", username)
            state["followed"].append(username)
            api.human_delay(2, 5)
        except Exception as e:
            log.error("follow %s failed: %s", username, e)
    save_state(state)


def run_engagement_session(
    target_creators: list[str],
    comments_per_creator: int = 1,
    dry_run: bool = False,
):
    state = load_state()
    random.shuffle(target_creators)
    for username in target_creators:
        log.info("── session: %s ──", username)
        try:
            user = api.get_user(username)
            creator_id = user.get("id")
            if creator_id and username not in state["visited"]:
                api.record_profile_visit(creator_id)
                state["visited"].append(username)
                log.info("visited profile %s", username)
            api.human_delay(3, 8)
            run_comment_on_creator(username, n_posts=comments_per_creator, dry_run=dry_run)
        except Exception as e:
            log.error("session failed for %s: %s", username, e)
        api.human_delay(10, 30)

    save_state(state)
    log.info("session done")
