#!/usr/bin/env python3
"""Update the public incursion transition history from EVE ESI once."""

from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "data" / "incursion-state.json"
ESI_URL = "https://esi.evetech.net/latest/incursions/?datasource=tranquility"
USER_AGENT = "EVE-Incursion-Watch/1.0 (GitHub Pages state tracker)"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_state() -> dict[str, Any]:
    try:
        with DATA_FILE.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict) and isinstance(loaded.get("incursions"), dict):
            return loaded
    except (FileNotFoundError, json.JSONDecodeError, OSError) as error:
        print(f"State history could not be loaded; starting fresh: {error}")
    return {"version": 1, "updated_at": None, "incursions": {}}


def fetch_incursions() -> list[dict[str, Any]]:
    request = urllib.request.Request(
        ESI_URL,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.load(response)
    if not isinstance(payload, list):
        raise ValueError("ESI returned an unexpected response shape")
    return payload


def update_state(state: dict[str, Any], incursions: list[dict[str, Any]]) -> bool:
    now = utc_now()
    records = state.setdefault("incursions", {})
    active_ids: set[str] = set()
    changed = False

    for incursion in incursions:
        constellation_id = incursion.get("constellation_id")
        incursion_state = str(incursion.get("state", "unknown")).lower()
        if not isinstance(constellation_id, int):
            continue

        key = str(constellation_id)
        active_ids.add(key)
        previous = records.get(key)
        if (
            isinstance(previous, dict)
            and previous.get("active")
            and previous.get("state") == incursion_state
        ):
            continue

        is_continuing_spawn = isinstance(previous, dict) and previous.get("active")
        records[key] = {
            "active": True,
            "constellation_id": constellation_id,
            "first_seen_at": previous.get("first_seen_at", now) if is_continuing_spawn else now,
            "state": incursion_state,
            "state_changed_at": now,
        }
        changed = True

    for key, record in records.items():
        if key not in active_ids and isinstance(record, dict) and record.get("active"):
            record["active"] = False
            record["ended_at"] = now
            changed = True

    if changed:
        state["updated_at"] = now
    return changed


def save_state(state: dict[str, Any]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, DATA_FILE)


def main() -> None:
    state = load_state()
    incursions = fetch_incursions()
    if update_state(state, incursions):
        save_state(state)
        print("Incursion history changed; state file updated.")
    else:
        print("No incursion lifecycle changes detected.")


if __name__ == "__main__":
    main()
