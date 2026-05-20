import os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
AUTH_FILE = Path(__file__).parent / "auth.json"
EMAIL = os.environ.get("CLUB_EMAIL")
PASSWORD = os.environ.get("CLUB_PASSWORD")
if not EMAIL or not PASSWORD:
    sys.exit("CLUB_EMAIL and CLUB_PASSWORD must be set in the environment (.env)")

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=False, channel="chrome",
                                  args=["--window-size=1280,720"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 720})
    page = ctx.new_page()

    page.goto("https://club.com")
    time.sleep(2)

    # Open login modal
    page.click("text=Log in or sign up", timeout=10000)
    time.sleep(2)
    page.screenshot(path="debug_2_modal.png")

    # Click Google button by coordinate (2nd icon in modal row)
    # Based on screenshot: modal center ~640, provider buttons row at ~317
    # X, Google, Kick, Twitch — widths ~55px each, starting at ~466
    # Google button center: ~594, 317
    page.mouse.click(594, 317)
    time.sleep(3)

    print(f"URL after Google click: {page.url}")
    page.screenshot(path="debug_3_google.png")

    # Fill Google credentials
    try:
        page.wait_for_selector('input[type="email"]', timeout=10000)
        page.fill('input[type="email"]', EMAIL)
        page.keyboard.press("Enter")
        time.sleep(3)
        page.wait_for_selector('input[type="password"]', timeout=10000)
        page.fill('input[type="password"]', PASSWORD)
        page.keyboard.press("Enter")
        print("Credentials submitted")
    except Exception as e:
        print(f"Login error: {e}")

    print("Waiting for club.com...")
    try:
        page.wait_for_url("https://club.com/**", timeout=60000)
    except Exception:
        pass
    time.sleep(3)
    print(f"Final URL: {page.url}")
    page.screenshot(path="debug_4_final.png")

    ctx.storage_state(path=str(AUTH_FILE))
    print(f"Saved: {AUTH_FILE}")
    browser.close()
