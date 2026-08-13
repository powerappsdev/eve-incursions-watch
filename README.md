# EVE Incursion Watch

A dependency-free GitHub Pages dashboard for current Tranquility incursions from EVE Online's public ESI API. It resolves readable system and constellation names, groups infected systems into Staging, Vanguard, Assault, and Headquarters roles, marks security status and NPC stations, and copies a system name when it is clicked.

## Hosting

The included GitHub Actions workflow publishes the site to GitHub Pages and polls ESI every five minutes. It writes `data/incursion-state.json` only when an incursion starts, ends, or changes state. This preserves the transition time used by **Max. remaining** without a server or paid database.

The workflow can also be run manually from the repository's **Actions** tab. GitHub may delay scheduled jobs during busy periods, and it automatically disables scheduled workflows in a public repository after 60 days without repository activity.

## Run locally

Use the included local server to serve the page and maintain state-change history while developing:

```powershell
py server.py
```

or, if `py` is unavailable:

```powershell
python server.py
```

Then open <http://localhost:8080>. Stop the server with **Ctrl+C** when finished. No API key, EVE login, package installation, or build step is required.

## API calls

- `GET https://esi.evetech.net/latest/incursions/?datasource=tranquility`
- `POST https://esi.evetech.net/latest/universe/names/?datasource=tranquility`
- `GET data/incursion-state.json` (maintained by GitHub Actions or the local tracker)

The UI handles timeouts, HTTP/network/CORS failures, empty results, malformed records, and failed name lookups. If name resolution fails, incursion data still renders with numeric IDs. If the shared timing file is unavailable, the page estimates timing from when that browser first observes the state.

## Max. remaining

The reference project calculates maximum remaining lifetime from its recorded `lastStateChangeDate`: three days for Mobilizing, eight days for Established, and one day for other states. ESI does not expose that timestamp, so the scheduled workflow runs `scripts/update_incursion_state.py` and stores each observed transition in `data/incursion-state.json`.

The file was initially seeded from the reference site for continuity, but the running page no longer contacts or depends on that site. If the tracker misses a transition, its next run records the time it first observes the new state.

## System roles and static data

ESI returns the staging-system ID and a flat list of infected-system IDs, but it does not identify Vanguard, Assault, or Headquarters systems. `system-types.js` contains the static system-role mapping from the public [eve-incursions-node](https://github.com/Shadowlauch/eve-incursions-node) database seed dated 2026-08-03. The live ESI staging-system ID always takes precedence. Unknown systems are shown as **Unclassified** rather than guessed.

`station-systems.js` contains systems with at least one NPC station from the same public seed. Player-owned Upwell structures are not included.

`system-security.js` contains each solar system's security status from that seed. Values use the reference project's EVE-style formatting: positive security to one decimal place and zero or negative security to two decimal places.

## Data fields used

The current incursion response supplies `constellation_id`, `faction_id`, `has_boss`, `infested_solar_systems`, `influence`, `staging_solar_system_id`, `state`, and `type`.

The deployed implementation is client-only and uses the browser's `fetch` API. No EVE login, API key, package installation, build system, or paid data service is required.
