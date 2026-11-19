# EVE Incursion Watch

[View the online version](https://powerappsdev.github.io/eve-incursions-watch/)

A dependency-free GitHub Pages dashboard for current Tranquility incursions from EVE Online's public ESI API. It resolves readable system and constellation names, groups infected systems into Staging, Vanguard, Assault, and Headquarters roles, marks security status and NPC stations, and copies a system name when it is clicked.


## Dashboard controls

Cards are headed by constellation, with the region underneath. The staging system remains in the Staging group. Region lookups are cached for the current page session; an unavailable region does not prevent the incursion from being displayed.

Use All, High-sec, Low-sec, or Null-sec to filter incursions by their staging system's security space. Your choice is saved in this browser. Incursions with unknown security remain visible under All. Click any system name to copy it; the station marker indicates an NPC station.

Countdowns use days, hours, and minutes for every phase. They are maximum estimates, not guaranteed expiration times. Each card identifies whether its estimate comes from the shared tracker or this browser's first observation.

## Hosting

GitHub Pages hosts the site. The Cloudflare Worker in `collector/` checks ESI every five minutes and stores lifecycle history and a successful-check heartbeat in D1. It respects ESI's cache expiry and retains existing history when ESI fails or returns invalid data. The dashboard reads the Worker's public `/state` endpoint; readers cannot submit history or alter records. The first read initializes an empty database. The legacy GitHub Actions collector remains enabled as a separate backup, but its data is not used by the live page; disabling that schedule requires GitHub workflow-write authorization.

Deploy the collector with `npx wrangler deploy --config collector/wrangler.jsonc`. For another account, replace the account/database identifiers and the dashboard's `TIMINGS_URL`. Create its table using `collector/schema.sql`. Run `node collector/test.mjs` for lifecycle tests. Keep Cloudflare credentials out of this repository. The existing Python scripts and JSON remain available for manual/local operation and initial migration.

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
- `GET https://esi.evetech.net/latest/universe/constellations/{constellation_id}/`
- `GET https://esi.evetech.net/latest/universe/regions/{region_id}/`
- `GET https://eve-incursions-collector.eve-incursion-watch.workers.dev/state` (Cloudflare collector; no authentication required for reads)

The UI handles timeouts, HTTP/network/CORS failures, empty results, malformed records, and failed name lookups. If name resolution fails, incursion data still renders with numeric IDs. If the shared timing file is unavailable, the page estimates timing from when that browser first observes the state.

## Max. remaining

### High-sec spawn estimate

When ESI reports no active high-sec incursion, the banner uses the latest recorded high-sec end time: a 12-hour cooldown, then a spawn window through hour 36. After 36 hours it asks you to refresh. The rule mirrors [the reference project's spawn banner](https://github.com/Shadowlauch/eve-incursions-node/blob/master/packages/frontend/src/components/spawn/lastHsSpawn.tsx); it is an estimate, not an ESI forecast. Polling delays can make the recorded end time later than the actual end.

The estimate is independent of the security filter and disappears whenever a high-sec incursion is active. Missing history, unknown security, or a tracker that has not yet recorded the latest end produces an unavailable message rather than a guessed timer. New ends save the interval between last seen and first absent, displayed as a countdown range. These are observation times, not exact in-game timestamps; ESI caching adds uncertainty. Shared data older than fifteen minutes is rejected; after ten minutes without a page refresh, the banner asks you to refresh. Legacy history is resolved through ESI constellation data and the static staging/security maps.

## Incursion lifetime calculation

The reference project calculates maximum remaining lifetime from its recorded `lastStateChangeDate`: three days for Mobilizing, eight days for Established, and one day for other states. ESI does not expose that timestamp, so the collector saves the time it observes each transition.

The collector imports the existing repository history once when its database is empty. That seed originally came from the reference site. The Yekti end recorded late on November 19, 2026 is corrected during import to 04:20:02 UTC, attributed to eve-incursions.com/history. Ongoing collection depends only on ESI, not that site. If collection misses a transition, the next successful run records its observation rather than inventing an exact end time.

## System roles and static data

ESI returns the staging-system ID and a flat list of infected-system IDs, but it does not identify Vanguard, Assault, or Headquarters systems. `system-types.js` contains the static system-role mapping from the public [eve-incursions-node](https://github.com/Shadowlauch/eve-incursions-node) database seed dated 2026-08-03. The live ESI staging-system ID always takes precedence. Unknown systems are shown as **Unclassified** rather than guessed.

`station-systems.js` contains systems with at least one NPC station from the same public seed. Player-owned Upwell structures are not included.

`system-security.js` contains each solar system's security status from that seed. Values use the reference project's EVE-style formatting: positive security to one decimal place and zero or negative security to two decimal places.

## Data fields used

The current incursion response supplies `constellation_id`, `faction_id`, `has_boss`, `infested_solar_systems`, `influence`, `staging_solar_system_id`, `state`, and `type`.

The deployed implementation is client-only and uses the browser's `fetch` API. No EVE login, API key, package installation, build system, or paid data service is required.
