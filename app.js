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

const list = document.querySelector("#incursion-list");
const template = document.querySelector("#incursion-template");
const refreshButton = document.querySelector("#refresh-button");
const statusDot = document.querySelector("#status-dot");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const copyStatus = document.querySelector("#copy-status");
let copyStatusTimer;
let remainingTimer;

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
  const raw = Number(SYSTEM_SECURITY[id]);
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

function formatRemaining(targetTime, state) {
  const remaining = Math.max(0, targetTime - Date.now());
  if (remaining === 0) return "maximum reached";

  if (state === "established") {
    const days = Math.floor(remaining / DAY_MS);
    return `up to ${days} day${days === 1 ? "" : "s"}`;
  }

  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
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
    container.append(group);
  }
}

function renderIncursion(item, names, timing) {
  const node = template.content.cloneNode(true);
  const percent = Math.max(0, Math.min(100, Number(item.influence) * 100));
  const state = item.state || "unknown";

  node.querySelector(".state-pill").textContent = state;
  const boss = node.querySelector(".boss-pill");
  boss.textContent = item.has_boss ? "Mothership present" : "No mothership";
  if (!item.has_boss) boss.classList.add("hidden");

  node.querySelector(".constellation-name").textContent = labelFor(item.staging_solar_system_id, names, "System");
  node.querySelector(".type-line").textContent = `${labelFor(item.constellation_id, names, "Constellation")} constellation`;
  const remaining = node.querySelector(".max-remaining");
  remaining.dataset.targetTime = String(timing.changedAt + lifetimeForState(timing.state));
  remaining.dataset.incursionState = timing.state;
  remaining.title = timing.source === "tracker"
    ? "Calculated from the state-change time recorded by the ESI tracker."
    : "Estimated from when this browser first observed the state because ESI does not supply its start time.";
  const infectedCount = item.infested_solar_systems.length;
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
  refreshButton.disabled = true;
  list.replaceChildren();
  setStatus("loading", "Contacting ESI…", "Loading current incursions.");

  try {
    const raw = await fetchJson(INCURSIONS_URL);
    if (!Array.isArray(raw)) throw new Error("ESI returned an unexpected response shape");
    const incursions = raw.filter(validIncursion);

    if (!incursions.length) {
      setStatus("", "No active incursions", "ESI currently reports no active incursions on Tranquility.");
      return;
    }

    let names = new Map();
    let namesWarning = "";
    let timings = localTimingData(incursions);
    const [namesResult, timingsResult] = await Promise.allSettled([
      getNames(incursions),
      getTimingData(incursions),
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
    incursions.forEach((item) => renderIncursion(item, names, timings.get(item.constellation_id)));
    updateRemainingTimes();
    remainingTimer = setInterval(updateRemainingTimes, 1000);
    const fetchedAt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date());
    setStatus("", `${incursions.length} active incursion${incursions.length === 1 ? "" : "s"}`, `Updated at ${fetchedAt}.${namesWarning}`);
  } catch (error) {
    console.error("Unable to load incursions", error);
    setStatus("error", "Unable to load incursions", friendlyError(error));
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadIncursions);
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
