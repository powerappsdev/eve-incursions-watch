#!/usr/bin/env python3
"""Serve EVE Incursion Watch and persist ESI state-transition times."""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "incursion-state.json"
ESI_URL = "https://esi.evetech.net/latest/incursions/?datasource=tranquility"
USER_AGENT = "EVE-Incursion-Watch/1.0 (local personal tracker)"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class IncursionTracker:
    def __init__(self, poll_seconds: int) -> None:
        self.poll_seconds = max(60, poll_seconds)
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.state = self._load_state()

    def _load_state(self) -> dict[str, Any]:
        try:
            with DATA_FILE.open("r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict) and isinstance(loaded.get("incursions"), dict):
                return loaded
        except (FileNotFoundError, json.JSONDecodeError, OSError) as error:
            print(f"State history could not be loaded; starting fresh: {error}")
        return {"version": 1, "updated_at": None, "incursions": {}}

    def _save_state(self) -> None:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = DATA_FILE.with_suffix(".json.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(self.state, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, DATA_FILE)

    def poll(self) -> None:
        request = urllib.request.Request(
            ESI_URL,
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            incursions = json.load(response)
        if not isinstance(incursions, list):
            raise ValueError("ESI returned an unexpected response shape")

        now = utc_now()
        active_ids: set[str] = set()
        changed = False
        with self.lock:
            records = self.state["incursions"]
            for incursion in incursions:
                constellation_id = incursion.get("constellation_id")
                state = str(incursion.get("state", "unknown")).lower()
                if not isinstance(constellation_id, int):
                    continue

                key = str(constellation_id)
                active_ids.add(key)
                previous = records.get(key)
                if (
                    isinstance(previous, dict)
                    and previous.get("active")
                    and previous.get("state") == state
                ):
                    continue

                is_continuing_spawn = isinstance(previous, dict) and previous.get("active")
                records[key] = {
                    "active": True,
                    "constellation_id": constellation_id,
                    "first_seen_at": previous.get("first_seen_at", now) if is_continuing_spawn else now,
                    "state": state,
                    "state_changed_at": now,
                }
                changed = True

            for key, record in records.items():
                if key not in active_ids and record.get("active"):
                    record["active"] = False
                    record["ended_at"] = now
                    changed = True

            if changed:
                self.state["updated_at"] = now
                self._save_state()
        suffix = "; lifecycle history updated" if changed else "; no lifecycle changes"
        print(f"[{now}] Tracked {len(active_ids)} active incursions{suffix}.")

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.poll()
            except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
                print(f"[{utc_now()}] ESI poll failed; keeping existing history: {error}")
            self.stop_event.wait(self.poll_seconds)

    def timings(self) -> dict[str, Any]:
        with self.lock:
            records = [
                {
                    "constellation_id": record["constellation_id"],
                    "state": record["state"],
                    "last_state_change": record["state_changed_at"],
                }
                for record in self.state["incursions"].values()
                if record.get("active")
            ]
            return {"updated_at": self.state.get("updated_at"), "timings": records}


def make_handler(tracker: IncursionTracker):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT), **kwargs)

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/api/timings":
                self._send_json(tracker.timings())
                return
            if path == "/api/health":
                self._send_json({"ok": True, "updated_at": tracker.timings()["updated_at"]})
                return
            super().do_GET()

        def _send_json(self, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve and track EVE Incursion Watch")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--poll-seconds", type=int, default=300)
    args = parser.parse_args()

    tracker = IncursionTracker(args.poll_seconds)
    poller = threading.Thread(target=tracker.run, name="esi-poller", daemon=True)
    poller.start()

    server = ThreadingHTTPServer((args.host, args.port), make_handler(tracker))
    print(f"EVE Incursion Watch: http://{args.host}:{args.port}")
    print(f"ESI tracker interval: {tracker.poll_seconds} seconds. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping…")
    finally:
        tracker.stop_event.set()
        server.server_close()


if __name__ == "__main__":
    main()
