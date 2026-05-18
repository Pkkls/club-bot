"""
Scheduled runner: injects orchestrator.js into the first club.com Chrome tab.
Uses Chrome DevTools Protocol (CDP) via websocket.

Requires Chrome to be running with --remote-debugging-port=9222

Add to Windows Task Scheduler:
  Program: C:\Users\kil\Downloads\filefs\club-bot\.venv\Scripts\python.exe
  Args:     C:\Users\kil\Downloads\filefs\club-bot\run_session.py
  Schedule: Every 6 hours between 8:00 and 23:00
"""
import json, sys, time, urllib.request, urllib.error
from pathlib import Path

CDP_HOST = "http://localhost:9222"
SCRIPT = Path(__file__).parent / "orchestrator.js"


def get_club_tab():
    with urllib.request.urlopen(f"{CDP_HOST}/json") as r:
        tabs = json.loads(r.read())
    for tab in tabs:
        if "club.com" in tab.get("url", ""):
            return tab
    return None


def inject_script(tab, script):
    import websocket
    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=10)
    payload = json.dumps({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {"expression": script, "awaitPromise": False}
    })
    ws.send(payload)
    time.sleep(1)
    ws.close()


def main():
    try:
        tab = get_club_tab()
    except Exception as e:
        print(f"Chrome CDP not available: {e}")
        print("Make sure Chrome is running with --remote-debugging-port=9222")
        sys.exit(1)

    if not tab:
        print("No club.com tab found. Open Chrome and navigate to club.com first.")
        sys.exit(1)

    print(f"Found tab: {tab['title']} ({tab['url']})")
    script = SCRIPT.read_text(encoding="utf-8")
    inject_script(tab, script)
    print("Session injected.")


if __name__ == "__main__":
    main()
