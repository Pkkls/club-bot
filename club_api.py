"""
Club.com API client — Playwright with saved auth state (auth.json).

First-time setup:  python setup_auth.py
Then run bot:      python main.py --check
"""
import json
import time
import random
import logging
from pathlib import Path

from playwright.sync_api import sync_playwright, BrowserContext, Page

BASE = "https://club.com"
AUTH_FILE = Path(__file__).parent / "auth.json"
log = logging.getLogger("club_api")

_ctx: BrowserContext | None = None
_page: Page | None = None
_pw = None


def _start_browser():
    global _ctx, _page, _pw
    if _ctx is not None:
        return _ctx, _page

    if not AUTH_FILE.exists():
        raise FileNotFoundError(
            f"auth.json not found. Run setup_auth.py first:\n"
            f"  python setup_auth.py\n"
            f"  (opens headed Chrome, log in via Google SSO)"
        )

    log.info("launching headless browser with saved auth...")
    _pw = sync_playwright().start()
    browser = _pw.chromium.launch(
        headless=True,
        channel="chrome",
        args=["--disable-blink-features=AutomationControlled"],
        ignore_default_args=["--enable-automation"],
    )
    _ctx = browser.new_context(
        storage_state=str(AUTH_FILE),
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        locale="en-US",
        timezone_id="America/New_York",
    )
    _page = _ctx.new_page()
    # Warm up session
    _page.goto(BASE, wait_until="domcontentloaded")
    log.info("browser ready")
    return _ctx, _page


def close_browser():
    global _ctx, _page, _pw
    if _ctx:
        try:
            _ctx.close()
        except Exception:
            pass
        _ctx = None
        _page = None
    if _pw:
        try:
            _pw.stop()
        except Exception:
            pass
        _pw = None


def _api(method: str, path: str, body: dict | None = None) -> dict:
    _, page = _start_browser()
    options = {"method": method.upper()}
    if body is not None:
        options["headers"] = {"content-type": "application/json"}
        options["body"] = json.dumps(body)
    response = page.request.fetch(f"{BASE}{path}", **options)
    if not response.ok:
        log.warning("%s %s -> %d: %s", method, path, response.status, response.text()[:200])
        if response.status == 401:
            raise PermissionError("Session expired -- delete auth.json and run setup_auth.py again")
        raise Exception(f"HTTP {response.status}: {response.text()[:100]}")
    try:
        return response.json()
    except Exception:
        return {"_text": response.text()}


def human_delay(min_s=1.5, max_s=5.0):
    time.sleep(random.uniform(min_s, max_s))


# ── Feed / posts ──────────────────────────────────────────────────────────────

def get_creator_posts(username: str, limit: int = 20) -> list[dict]:
    data = _api("GET", f"/api/feed?type=creator&username={username}&limit={limit}")
    return data.get("data", data.get("posts", []))


def get_post(post_id: str) -> dict:
    return _api("GET", f"/api/feed/{post_id}")


def get_comments(post_id: str, limit: int = 25) -> list[dict]:
    data = _api("GET", f"/api/feed/{post_id}/comments?limit={limit}")
    return data.get("comments", [])


def post_comment(post_id: str, text: str) -> dict:
    return _api("POST", f"/api/feed/{post_id}/comments", {"text": text})


# ── Users / follows ───────────────────────────────────────────────────────────

def get_user(username: str) -> dict:
    return _api("GET", f"/api/users/{username}")


def get_me() -> dict:
    return _api("GET", "/api/users/me")


def follow_user(user_id: str) -> dict:
    try:
        return _api("POST", f"/api/follows/{user_id}", {})
    except Exception as e:
        if "409" in str(e):
            log.info("already following %s", user_id)
            return {"already": True}
        raise


def record_profile_visit(creator_id: str):
    try:
        _api("POST", "/api/users/me/profile-visits", {"creatorId": creator_id})
    except Exception:
        pass
