"""Acid Lab desktop launcher: starts the local server (if needed) and opens the app window.

Drop a video or image onto the desktop shortcut to open it directly.
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 47833
URL = f"http://127.0.0.1:{PORT}/"
LOCAL = os.environ.get("LOCALAPPDATA", APP_DIR)


def ping():
    try:
        with urllib.request.urlopen(URL + "api/ping", timeout=0.8) as r:
            j = json.loads(r.read())
            return j if j.get("app") == "acid-lab" else None
    except Exception:
        return None


def hand_over(path):
    req = urllib.request.Request(URL + "api/request_open", data=json.dumps({"path": path}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass


def find_browser():
    pf, pf86 = os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    for p in (os.path.join(pf, r"Google\Chrome\Application\chrome.exe"),
              os.path.join(pf86, r"Google\Chrome\Application\chrome.exe"),
              os.path.join(LOCAL, r"Google\Chrome\Application\chrome.exe"),
              os.path.join(pf86, r"Microsoft\Edge\Application\msedge.exe"),
              os.path.join(pf, r"Microsoft\Edge\Application\msedge.exe")):
        if os.path.exists(p):
            return p
    return None


def open_window(path=None):
    url = URL + ("?open=" + urllib.parse.quote(path) if path else "")
    exe = find_browser()
    if not exe:
        webbrowser.open(url)
        return
    profile = os.path.join(LOCAL, "AcidLab", "window")
    subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                      "--no-default-browser-check", "--disable-features=Translate",
                      "--autoplay-policy=no-user-gesture-required", "--window-size=1600,1000"],
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def main():
    path = sys.argv[1] if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]) else None
    state = ping()
    if state:
        if path and state.get("window_alive"):
            hand_over(path)  # the open window picks it up on its next heartbeat
        else:
            open_window(path)
        return

    sys.path.insert(0, APP_DIR)
    import server  # redirects output to the log file

    def opener():
        for _ in range(200):
            if ping():
                break
            time.sleep(0.1)
        open_window(path)

    threading.Thread(target=opener, daemon=True).start()
    server.serve()


if __name__ == "__main__":
    main()
