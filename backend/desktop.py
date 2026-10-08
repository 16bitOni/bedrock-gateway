"""Bedrock Portal desktop launcher.

Double-click the packaged app (Bedrock Portal.exe / Bedrock Portal.app) and this:
  1. starts the gateway on http://127.0.0.1:8787 (or the next free port),
  2. opens the dashboard in its own window (falls back to your browser),
  3. stops the gateway when you close the window.

If the portal is already running, it just opens another window onto it.

Data (database, generated images, logs) lives in your user profile, not next to the exe:
  Windows: %APPDATA%\\BedrockPortal      macOS: ~/Library/Application Support/BedrockPortal
  Linux:   ~/.local/share/bedrock-portal

Run from source:  python desktop.py [--port 8787] [--browser] [--headless]
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP_NAME = "Bedrock Portal"
DEFAULT_PORT = 8787
FROZEN = getattr(sys, "frozen", False)


def bundle_dir() -> Path:
    """Where bundled resources live (PyInstaller temp dir when frozen, the repo when run from source)."""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def user_data_dir() -> Path:
    if sys.platform == "win32":
        root = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return root / "BedrockPortal"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "BedrockPortal"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "bedrock-portal"


def configure_environment(data_dir: Path) -> None:
    base = bundle_dir()
    os.environ.setdefault("PORTAL_DATA_DIR", str(data_dir))
    os.environ.setdefault("PORTAL_FRONTEND_DIST", str(base / "frontend" / "dist"))
    os.environ.setdefault("PORTAL_INFRA_DIR", str(base / "infra"))
    # A packaged app has no console: send output to a log file instead of nowhere.
    if FROZEN and (sys.stdout is None or sys.stderr is None):
        log = open(data_dir / "portal.log", "a", buffering=1, encoding="utf-8")  # noqa: SIM115
        sys.stdout = sys.stderr = log


def portal_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as r:
            return json.loads(r.read()).get("ok") is True
    except Exception:  # noqa: BLE001
        return False


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port(preferred: int) -> int:
    for p in range(preferred, preferred + 50):
        if port_free(p):
            return p
    raise SystemExit("No free port found between %d and %d." % (preferred, preferred + 49))


class Server:
    def __init__(self, port: int):
        import uvicorn

        from app.main import app  # imported after the environment is configured

        self.port = port
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, access_log=False,
                                proxy_headers=False, timeout_graceful_shutdown=3)
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, name="portal-server", daemon=True)

    def start(self, timeout: float = 30) -> None:
        self.thread.start()
        end = time.time() + timeout
        while time.time() < end:
            if self.server.started:
                return
            if not self.thread.is_alive():
                raise RuntimeError("The portal server failed to start (see portal.log in the data folder).")
            time.sleep(0.05)
        raise RuntimeError("The portal server did not start within %ds." % timeout)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


def message_box(text: str, title: str = APP_NAME) -> None:
    """Blocking native message box on Windows; stdout elsewhere."""
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)  # MB_ICONINFORMATION
    else:
        print(f"{title}: {text}")


def open_window(url: str) -> bool:
    """Show the dashboard in a native window. Returns False if no webview backend is available."""
    try:
        import webview  # pywebview: WebView2 on Windows, WKWebView on macOS
    except Exception:  # noqa: BLE001
        return False
    try:
        webview.create_window(APP_NAME, url, width=1440, height=920, min_size=(380, 600), confirm_close=True,
                              text_select=True)
        webview.start(private_mode=False, storage_path=str(user_data_dir() / "webview"))
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[desktop] native window unavailable: {e!r}")
        return False


def main() -> None:
    ap = argparse.ArgumentParser(description=APP_NAME)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORTAL_PORT", DEFAULT_PORT)))
    ap.add_argument("--browser", action="store_true", help="open in your default browser instead of a window")
    ap.add_argument("--headless", action="store_true", help="run only the API server (no window)")
    args = ap.parse_args()

    data_dir = user_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    configure_environment(data_dir)

    # Already running (e.g. the app was opened twice)? Just show it.
    if portal_running(args.port):
        url = f"http://127.0.0.1:{args.port}"
        if args.headless:
            print(f"{APP_NAME} is already running at {url}")
            return
        if args.browser or not open_window(url):
            webbrowser.open(url)
        return

    port = pick_port(args.port)
    url = f"http://127.0.0.1:{port}"
    server = Server(port)
    try:
        server.start()
    except RuntimeError as e:
        message_box(str(e))
        raise SystemExit(1) from e

    print(f"[desktop] {APP_NAME} running at {url}  (OpenAI base URL {url}/v1)  data: {data_dir}")
    if port != args.port:
        print(f"[desktop] port {args.port} was busy, using {port}")

    try:
        if args.headless:
            while server.thread.is_alive():
                time.sleep(1)
        elif args.browser or not open_window(url):
            webbrowser.open(url)
            if sys.platform == "win32" and FROZEN:
                message_box(f"{APP_NAME} is running at {url}\n\nOpenAI base URL: {url}/v1\n\n"
                            "Click OK to stop the portal.")
            else:
                print("[desktop] press Ctrl+C to stop")
                while server.thread.is_alive():
                    time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


if __name__ == "__main__":
    # Make `import app` work when run from source (python backend/desktop.py).
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
