"use strict";

const ESI_ROOT = "https://esi.evetech.net/latest";
const INCURSIONS_URL = `${ESI_ROOT}/incursions/?datasource=tranquility`;
const NAMES_URL = `${ESI_ROOT}/universe/names/?datasource=tranquility`;
const TIMINGS_URL = new URL("data/incursion-state.json", document.baseURI);
const REQUEST_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OBSERVED_STATES_KEY = "eve-incursion-observed-states-v1";
const SYSTEM_TYPES = window.INCURSION_SYSTEM_TYPES ?? {};
const STATION_SYSTEMS = window.SYSTEMS_WITH_STATIONS ?? new Set();
const SYSTEM_SECURITY = window.SYSTEM_SECURITY ?? {};
const ROLE_ORDER = ["Staging", "Vanguard", "Assault", "Headquarters", "Unclassified"];
const SECURITY_FILTER_KEY = "eve-incursion-security-filter-v1";
const SPACE_LABELS = { high: "High-sec", low: "Low-sec", null: "Null-sec", unknown: "Security unknown" };
const universeCache = new Map();

const list = document.querySelector("#incursion-list");
const template = document.querySelector("#incursion-template");
const refreshButton = document.querySelector("#refresh-button");
const statusDot = document.querySelector("#status-dot");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const copyStatus = document.querySelector("#copy-status");
const filterControls = document.querySelector("#security-filters");
const filterSummary = document.querySelector("#filter-summary");
const filterEmpty = document.querySelector("#filter-empty");
let selectedFilter = readSecurityFilter();
let hasLoaded = false;
let copyStatusTimer;
let remainingTimer;
const spawnPanel = document.querySelector("#hs-spawn-panel");
const spawnTitle = document.querySelector("#hs-spawn-title");
const spawnCountdown = document.querySelector("#hs-spawn-countdown");
const spawnDetail = document.querySelector("#hs-spawn-detail");
let spawnEstimate = null;
let spawnTimer;

function highSecSpawnPhase(endedAt, now = Date.now()) {
  if (!Number.isFinite(endedAt) || endedAt > now) return { kind: "unavailable" };
  const earliest = endedAt + 12 * 60 * 60 * 1000;
  const latest = endedAt + 36 * 60 * 60 * 1000;
  if (now < earliest) return { kind: "cooldown", target: earliest };
  if (now < latest) return { kind: "window", target: latest };
  return { kind: "overdue" };
}

async function historicalSecurityArea(record) {
  if (Number.isInteger(record.staging_solar_system_id)) {
    return securityForSystem(record.staging_solar_system_id)?.area ?? null;
  }
  // Older tracker records have no staging ID. Resolve their constellation and
  // use the reference staging map, or an entirely homogeneous security area.
  const constellation = await getUniverseRecord("constellations", record.constellation_id);
  if (!Array.isArray(constellation.systems) || !constellation.systems.length) return null;
  const staging = constellation.systems.filter((id) => SYSTEM_TYPES[id] === "Staging");
  const ids = staging.length ? staging : constellation.systems;
  const areas = ids.map((id) => securityForSystem(id)?.area ?? null);
  return areas.every((area) => area !== null && area === areas[0]) ? areas[0] : null;
}

async function getHighSecSpawnEstimate(incursions, history) {
  const currentAreas = incursions.map((item) => securityForSystem(item.staging_solar_system_id)?.area);
  if (currentAreas.includes("high")) return null;
  const unavailable = { kind: "unavailable" };
  if (currentAreas.some((area) => !area) || !history || typeof history !== "object") return unavailable;
  const liveIds = new Set(incursions.map((item) => item.constellation_id));
  const records = Object.values(history).filter((record) => record && Number.isInteger(record.constellation_id));
  // A missing live spawn may not have been marked ended by the scheduled
  // tracker yet. Do not show the previous spawn's timer while catching up.
  for (const record of records.filter((record) => record.active === true && !liveIds.has(record.constellation_id))) {
    const area = await historicalSecurityArea(record);
    if (!area || area === "high") return unavailable;
  }
  const ended = records.filter((record) => record.active === false)
    .sort((a, b) => (Date.parse(b.ended_at) || Infinity) - (Date.parse(a.ended_at) || Infinity));
  // Stop at unknown security rather than skipping a potentially newer HS end.
  for (const record of ended) {
    const area = await historicalSecurityArea(record);
    if (!area) return unavailable;
    if (area === "high") {
      const endedAt = Date.parse(record.ended_at);
      if (highSecSpawnPhase(endedAt).kind === "unavailable") return unavailable;
      return { endedAt, checkedAt: Date.now() };
    }
  }
  return unavailable;
}

function updateHighSecSpawnBanner() {
  spawnPanel.hidden = spawnEstimate === null;
  if (!spawnEstimate) return;
  const stale = Number.isFinite(spawnEstimate.checkedAt) && Date.now() - spawnEstimate.checkedAt > 10 * 60 * 1000;
  const phase = stale ? { kind: "unavailable" }
    : spawnEstimate.kind === "unavailable" ? spawnEstimate : highSecSpawnPhase(spawnEstimate.endedAt);
  spawnPanel.dataset.phase = phase.kind;
  spawnTitle.textContent = {
    cooldown: "No high-sec spawn expected in the next",
    window: "High-sec spawn window open · expected within",
    overdue: "High-sec spawn window elapsed",
    unavailable: "High-sec spawn timing unavailable",
  }[phase.kind];
  spawnCountdown.textContent = "";
  spawnCountdown.hidden = !Number.isFinite(phase.target);
  if (Number.isFinite(phase.target)) {
    const seconds = Math.max(0, Math.ceil((phase.target - Date.now()) / 1000));
    spawnCountdown.textContent = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
      .map((value) => String(value).padStart(2, "0")).join(":");
  }
  spawnDetail.textContent = phase.kind === "unavailable"
    ? stale ? "Refresh to check for a new high-sec spawn." : "Waiting for a confirmed high-sec end time in the shared history."
    : "Estimate: 12–36 hours after the last high-sec incursion ended. Tracker polling can delay the recorded end time."
      + (phase.kind === "overdue" ? " Refresh to check for a new spawn." : "");
}

function readSecurityFilter() {
  try {
    const value = localStorage.getItem(SECURITY_FILTER_KEY);
    return ["high", "low", "null"].includes(value) ? value : "all";
  } catch {
    return "all";
  }
}

function applySecurityFilter() {
  const cards = [...list.querySelectorAll(".incursion-card")];
  const counts = { all: cards.length, high: 0, low: 0, null: 0 };
  let visible = 0;
  for (const card of cards) {
    if (Object.hasOwn(counts, card.dataset.area)) counts[card.dataset.area]++;
    card.hidden = selectedFilter !== "all" && card.dataset.area !== selectedFilter;
    if (!card.hidden) visible++;
  }
  for (const button of filterControls.querySelectorAll("button[data-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === selectedFilter));
    button.querySelector(".filter-count").textContent = String(counts[button.dataset.filter]);
    button.disabled = !hasLoaded;
  }
  filterSummary.textContent = hasLoaded
    ? `Showing ${visible} of ${cards.length} · by staging system`
    : "";
  filterEmpty.hidden = !hasLoaded || cards.length === 0 || visible > 0;
}

function selectSecurityFilter(value) {
  selectedFilter = ["high", "low", "null"].includes(value) ? value : "all";
  try {
    localStorage.setItem(SECURITY_FILTER_KEY, selectedFilter);
  } catch {
    // Filtering remains available when browser storage is blocked.
  }
  applySecurityFilter();
}

function setStatus(kind, title, detail) {
  statusDot.className = `status-dot ${kind}`.trim();
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", ...options.headers },
    });

    if (!response.ok) {
      throw new Error(`Request returned ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function validIncursion(item) {
  return item && Number.isInteger(item.constellation_id)
    && Number.isInteger(item.staging_solar_system_id)
    && Array.isArray(item.infested_solar_systems);
}

async function getNames(incursions) {
  const ids = [...new Set(incursions.flatMap((item) => [
    item.constellation_id,
    item.staging_solar_system_id,
    ...item.infested_solar_systems,
  ]).filter(Number.isInteger))];

  if (!ids.length) return new Map();

  const records = await fetchJson(NAMES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ids),
  });
  return new Map(records.map(({ id, name }) => [id, name]));
}

function getUniverseRecord(kind, id) {
  const key = `${kind}/${id}`;
  if (!universeCache.has(key)) {
    const request = fetchJson(`${ESI_ROOT}/universe/${key}/?datasource=tranquility`)
      .then((record) => {
        if (typeof record?.name !== "string" || !record.name.trim()
          || (kind === "constellations" && !Number.isInteger(record.region_id))) {
          throw new Error("Unexpected universe response");
        }
        return record;
      })
      .catch((error) => {
        universeCache.delete(key); // Allow a later refresh to retry a failed lookup.
        throw error;
      });
    universeCache.set(key, request);
  }
  return universeCache.get(key);
}

async function getLocations(incursions) {
  const ids = [...new Set(incursions.map((item) => item.constellation_id))];
  const results = await Promise.allSettled(ids.map(async (id) => {
    const constellation = await getUniverseRecord("constellations", id);
    let regionName = null;
    try {
      regionName = (await getUniverseRecord("regions", constellation.region_id)).name;
    } catch {
      // Keep the constellation name even if its region cannot be resolved.
    }
    return [id, { constellationName: constellation.name, regionId: constellation.region_id, regionName }];
  }));
  return new Map(results.filter((result) => result.status === "fulfilled").map((result) => result.value));
}

function readObservedStates() {
  try {
    const stored = JSON.parse(localStorage.getItem(OBSERVED_STATES_KEY) || "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

function writeObservedStates(states) {
  try {
    localStorage.setItem(OBSERVED_STATES_KEY, JSON.stringify(states));
  } catch {
    // The countdown still works for this page load when storage is unavailable.
  }
}

function localTimingData(incursions) {
  const now = Date.now();
  const observed = readObservedStates();
  const result = new Map();
  const activeIds = new Set(incursions.map((item) => String(item.constellation_id)));

  for (const item of incursions) {
    const key = String(item.constellation_id);
    const state = String(item.state || "unknown").toLowerCase();
    const existing = observed[key];
    const changedAt = existing?.state === state && Number.isFinite(existing.changedAt)
      ? existing.changedAt
      : now;
    observed[key] = { state, changedAt };
    result.set(item.constellation_id, { state, changedAt, source: "local" });
  }

  for (const key of Object.keys(observed)) {
    if (!activeIds.has(key)) delete observed[key];
  }
  writeObservedStates(observed);
  return result;
}

async function getTimingData(incursions) {
  const timings = localTimingData(incursions);
  const url = new URL(TIMINGS_URL);
  url.searchParams.set("v", String(Date.now()));
  const payload = await fetchJson(url, { cache: "no-store" });
  timings.history = payload?.incursions;

  const records = Array.isArray(payload?.timings)
    ? payload.timings
    : Object.values(payload?.incursions ?? {})
      .filter((record) => record?.active)
      .map((record) => ({
        constellation_id: record.constellation_id,
        state: record.state,
        last_state_change: record.state_changed_at,
      }));

  if (!records.length && !Array.isArray(payload?.timings) && !payload?.incursions) {
    throw new Error("State tracker returned an unexpected response shape");
  }

  const currentByConstellation = new Map(incursions.map((item) => [item.constellation_id, item]));
  for (const spawn of records) {
    const constellationId = Number(spawn?.constellation_id);
    const changedAt = Date.parse(spawn?.last_state_change);
    const state = String(spawn?.state || "").toLowerCase();
    const current = currentByConstellation.get(constellationId);
    if (current && state === String(current.state || "").toLowerCase() && Number.isFinite(changedAt)) {
      timings.set(constellationId, { state, changedAt, source: "tracker" });
    }
  }
  return timings;
}

function labelFor(id, names, prefix) {
  return names.get(id) ?? `${prefix} ${id}`;
}

function roleForSystem(id, stagingSystemId) {
  if (id === stagingSystemId) return "Staging";
  const mappedRole = SYSTEM_TYPES[id];
  return mappedRole && mappedRole !== "Staging" ? mappedRole : "Unclassified";
}

function securityForSystem(id) {
  const raw = SYSTEM_SECURITY[id];
  if (!Number.isFinite(raw)) return null;
  const rounded = raw > 0 ? Number(raw.toFixed(1)) : Number(raw.toFixed(2));
  return {
    area: rounded <= 0 ? "null" : rounded >= 0.5 ? "high" : "low",
    label: raw > 0 ? raw.toFixed(1) : raw.toFixed(2),
  };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy was rejected");
}

function showCopyStatus(message, isError = false) {
  clearTimeout(copyStatusTimer);
  copyStatus.textContent = message;
  copyStatus.classList.toggle("error", isError);
  copyStatus.hidden = false;
  copyStatusTimer = setTimeout(() => { copyStatus.hidden = true; }, 2200);
}

function lifetimeForState(state) {
  if (state === "mobilizing") return 3 * DAY_MS;
  if (state === "established") return 8 * DAY_MS;
  return DAY_MS;
}

function formatRemaining(targetTime) {
  if (!Number.isFinite(targetTime)) return "Unavailable";
  const remaining = Math.max(0, targetTime - Date.now());
  if (remaining === 0) return "Estimate elapsed";
  if (remaining < 60_000) return "< 1m";
  const totalMinutes = Math.floor(remaining / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
}

function updateRemainingTimes() {
  document.querySelectorAll(".max-remaining[data-target-time]").forEach((element) => {
    element.textContent = formatRemaining(Number(element.dataset.targetTime), element.dataset.incursionState);
  });
}

function renderSystemRoles(container, item, names) {
  const systemIds = [...new Set([...item.infested_solar_systems, item.staging_solar_system_id])];
  const groups = new Map(ROLE_ORDER.map((role) => [role, []]));

  for (const id of systemIds) {
    groups.get(roleForSystem(id, item.staging_solar_system_id)).push(id);
  }

  for (const role of ROLE_ORDER) {
    const ids = groups.get(role);
    if (!ids.length) continue;

    const group = document.createElement("section");
    group.className = "role-group";
    group.dataset.role = role;

    const heading = document.createElement("div");
    heading.className = "role-heading";
    const name = document.createElement("span");
    name.className = "role-name";
    name.textContent = role;
    const count = document.createElement("span");
    count.className = "role-count";
    count.textContent = String(ids.length);
    count.title = `${ids.length} system${ids.length === 1 ? "" : "s"}`;
    count.setAttribute("aria-label", `${ids.length} system${ids.length === 1 ? "" : "s"}`);
    heading.append(name, count);

    const systems = document.createElement("ul");
    systems.className = "role-systems";
    ids.map((id) => ({ id, name: labelFor(id, names, "System") }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(({ id, name: systemName }) => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "system-copy";
        button.dataset.systemName = systemName;
        const hasStation = STATION_SYSTEMS.has(id);
        const security = securityForSystem(id);
        const securityDescription = security ? `; security ${security.label}` : "";
        button.setAttribute("aria-label", `Copy ${systemName} to clipboard${securityDescription}${hasStation ? "; NPC station present" : ""}`);

        const name = document.createElement("span");
        name.className = "system-name";
        name.textContent = systemName;
        button.append(name);

        if (security) {
          const indicator = document.createElement("span");
          indicator.className = `security-indicator ${security.area}`;
          indicator.textContent = security.label;
          indicator.title = `Security status ${security.label} (${security.area} security)`;
          button.append(indicator);
        }

        if (hasStation) {
          const indicator = document.createElement("span");
          indicator.className = "station-indicator";
          indicator.title = "NPC station present";
          const dot = document.createElement("span");
          dot.className = "station-dot";
          dot.setAttribute("aria-hidden", "true");
          indicator.append(dot, "Station");
          button.append(indicator);
        }

        li.append(button);
        systems.append(li);
      });

    group.append(heading, systems);
    if (role === "Unclassified") {
      const note = document.createElement("p");
      note.className = "role-note";
      note.textContent = "System roles unavailable in our reference data.";
      group.append(note);
    }
    container.append(group);
  }
}

function renderIncursion(item, names, timing, place) {
  const node = template.content.cloneNode(true);
  const percent = Math.max(0, Math.min(100, Number(item.influence) * 100));
  const state = item.state || "unknown";
  const card = node.querySelector(".incursion-card");
  card.dataset.state = String(state).toLowerCase();
  const area = securityForSystem(item.staging_solar_system_id)?.area ?? "unknown";
  card.dataset.area = area;
  const space = node.querySelector(".space-pill");
  space.textContent = SPACE_LABELS[area];
  space.classList.add(area);
  space.title = "Security space of the staging system";

  node.querySelector(".state-pill").textContent = state;
  const boss = node.querySelector(".boss-pill");
  boss.textContent = item.has_boss ? "Mothership present" : "No mothership";
  if (!item.has_boss) boss.classList.add("hidden");

  node.querySelector(".constellation-name").textContent = place?.constellationName ?? labelFor(item.constellation_id, names, "Constellation");
  node.querySelector(".type-line").textContent = place?.regionName
    ? `${place.regionName} region`
    : place?.regionId ? `Region ${place.regionId} · name unavailable` : "Region unavailable";
  const remaining = node.querySelector(".max-remaining");
  remaining.dataset.targetTime = String(timing.changedAt + lifetimeForState(timing.state));
  remaining.dataset.incursionState = timing.state;
  remaining.title = timing.source === "tracker"
    ? "Maximum estimate based on a recorded state change, not a guaranteed expiry. Tracker delays can affect accuracy."
    : "Maximum estimate from when this browser first observed the state. ESI does not supply its start time, so this can overestimate the time left.";
  node.querySelector(".timing-note").textContent = timing.source === "tracker"
    ? "Maximum estimate · shared tracker"
    : "Maximum estimate · first seen in this browser";
  const infectedCount = new Set([...item.infested_solar_systems, item.staging_solar_system_id]).size;
  node.querySelector(".infected-count").textContent = `${infectedCount} system${infectedCount === 1 ? "" : "s"}`;
  node.querySelector(".influence-value").textContent = `${percent.toFixed(1)}%`;

  const track = node.querySelector(".influence-track");
  track.setAttribute("aria-valuenow", percent.toFixed(1));
  track.setAttribute("aria-label", `Sansha influence: ${percent.toFixed(1)} percent`);
  node.querySelector(".influence-fill").style.width = `${percent}%`;

  renderSystemRoles(node.querySelector(".role-groups"), item, names);
  list.append(node);
}

function friendlyError(error) {
  if (error?.name === "AbortError") return "The ESI request timed out. Try again in a moment.";
  if (location.protocol === "file:") return "The browser could not reach ESI. Run this page through a local web server (see README.md) and try again.";
  return "The browser could not reach ESI. Check your connection or try again shortly.";
}

async function loadIncursions() {
  clearInterval(remainingTimer);
  clearInterval(spawnTimer);
  spawnEstimate = null;
  updateHighSecSpawnBanner();
  refreshButton.disabled = true;
  hasLoaded = false;
  list.replaceChildren();
  applySecurityFilter();
  setStatus("loading", "Contacting ESI…", "Loading current incursions.");

  try {
    const raw = await fetchJson(INCURSIONS_URL);
    if (!Array.isArray(raw)) throw new Error("ESI returned an unexpected response shape");
    const incursions = raw.filter(validIncursion);

    let names = new Map();
    let namesWarning = "";
    let timings = localTimingData(incursions);
    const [namesResult, timingsResult, locationsResult] = await Promise.allSettled([
      getNames(incursions),
      getTimingData(incursions),
      getLocations(incursions),
    ]);

    if (namesResult.status === "fulfilled") {
      names = namesResult.value;
    } else {
      const error = namesResult.reason;
      console.warn("ESI name lookup failed; displaying numeric IDs instead.", error);
      namesWarning = " Names could not be resolved, so some numeric IDs are shown.";
    }
    if (timingsResult.status === "fulfilled") {
      timings = timingsResult.value;
    } else {
      console.warn("Local timing tracker is unavailable; using browser-observed state times.", timingsResult.reason);
    }

    incursions.sort((a, b) => a.influence - b.influence);
    const locations = locationsResult.status === "fulfilled" ? locationsResult.value : new Map();
    incursions.forEach((item) => renderIncursion(item, names, timings.get(item.constellation_id), locations.get(item.constellation_id)));
    hasLoaded = true;
    applySecurityFilter();
    updateRemainingTimes();
    remainingTimer = setInterval(updateRemainingTimes, 30_000);
    // Keep the main incursion list usable even if the optional history lookup fails.
    try {
      spawnEstimate = await getHighSecSpawnEstimate(incursions, timings.history);
    } catch (error) {
      console.warn("High-sec spawn history lookup failed.", error);
      spawnEstimate = { kind: "unavailable" };
    }
    updateHighSecSpawnBanner();
    if (spawnEstimate) spawnTimer = setInterval(updateHighSecSpawnBanner, 1000);
    const fetchedAt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date());
    setStatus("", incursions.length ? `${incursions.length} active incursion${incursions.length === 1 ? "" : "s"}` : "No active incursions", `Live ESI checked at ${fetchedAt}.${namesWarning}`);
  } catch (error) {
    console.error("Unable to load incursions", error);
    setStatus("error", "Unable to load incursions", friendlyError(error));
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadIncursions);
filterControls.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-filter]") : null;
  if (button && !button.disabled) selectSecurityFilter(button.dataset.filter);
});
document.querySelector("#clear-filter").addEventListener("click", () => {
  selectSecurityFilter("all");
  filterControls.querySelector('button[data-filter="all"]').focus();
});
list.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest(".system-copy") : null;
  if (!button) return;

  const systemName = button.dataset.systemName;
  try {
    await copyText(systemName);
    button.classList.add("copied");
    setTimeout(() => button.classList.remove("copied"), 1000);
    showCopyStatus(`${systemName} copied to clipboard.`);
  } catch (error) {
    console.error("Unable to copy system name", error);
    showCopyStatus(`Could not copy ${systemName}.`, true);
  }
});
loadIncursions();
