"use strict";
// Run with: node scripts/test-dashboard.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8").replace(/loadIncursions\(\);\s*$/, "");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function node() {
  return {
    dataset: {}, textContent: "", hidden: false, disabled: false, children: [],
    attrs: {}, style: {}, classList: { add() {}, toggle() {} },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener() {}, focus() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelector() { return node(); },
    querySelectorAll() { return []; },
  };
}
function setup({ saved = null, storageBlocked = false } = {}) {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, node());
    return elements.get(selector);
  };
  const buttons = ["all", "high", "low", "null"].map((value) => {
    const button = node();
    button.dataset.filter = value;
    button.count = node();
    button.querySelector = () => button.count;
    return button;
  });
  get("#security-filters").querySelectorAll = () => buttons;
  get("#security-filters").querySelector = () => buttons[0];
  const list = get("#incursion-list");
  list.querySelectorAll = () => list.children;
  const storage = new Map(saved ? [["eve-incursion-security-filter-v1", saved]] : []);
  const context = vm.createContext({
    document: {
      baseURI: "http://localhost:8080/",
      querySelector: get,
      querySelectorAll: () => [],
      createElement: node,
    },
    window: { SYSTEM_SECURITY: { 1: 0.5, 2: 0.4, 3: -0.2, 4: 0, 5: null, 6: 0.46 }, SYSTEMS_WITH_STATIONS: new Set([1]) },
    localStorage: {
      getItem(key) { if (storageBlocked) throw Error("blocked"); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw Error("blocked"); storage.set(key, value); },
    },
    navigator: {}, Element: Object, location: { protocol: "http:" },
    URL, AbortController, console: { warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    fetch: async () => { throw Error("offline"); },
  });
  vm.runInContext(source, context);
  return { context, get, buttons, storage, list, run: (code) => vm.runInContext(code, context) };
}

(async () => {
  const app = setup();
  const { run } = app;
  for (const [id, area] of [[1, "high"], [2, "low"], [3, "null"], [4, "null"], [6, "high"]]) {
    assert.equal(run('securityForSystem(' + id + ').area'), area);
  }
  assert.equal(run("securityForSystem(5)"), null);
  assert.equal(run("securityForSystem(999)"), null);
  assert.equal(run("formatRemaining(Date.now() - 1)"), "Estimate elapsed");
  assert.equal(run("formatRemaining(NaN)"), "Unavailable");
  assert.equal(run("formatRemaining(Date.now() + 30000)"), "< 1m");
  assert.equal(run("formatRemaining(Date.now() + (1440 + 9*60 + 7)*60000 + 1000)"), "1d 9h 7m");
  assert.equal(run("formatRemaining(Date.now() + 6*DAY_MS + 1000)"), "6d 0h 0m");
  assert.equal(run("formatRemaining(Date.now() + 2*60000 + 1000)"), "0h 2m");
  assert.equal(run('lifetimeForState("mobilizing")'), 3 * 86400000);
  assert.equal(run('lifetimeForState("established")'), 8 * 86400000);
  assert.equal(run('lifetimeForState("withdrawing")'), 86400000);

  app.list.children = ["high", "null", "unknown"].map((area) => ({ dataset: { area } }));
  run('hasLoaded = true; selectSecurityFilter("high")');
  assert.deepEqual(app.list.children.map((card) => card.hidden), [false, true, true]);
  assert.equal(app.buttons[1].attrs["aria-pressed"], "true");
  assert.equal(app.buttons[0].count.textContent, "3");
  assert.equal(app.get("#filter-summary").textContent, "Showing 1 of 3 · by staging system");
  assert.equal(app.storage.get("eve-incursion-security-filter-v1"), "high");
  run('selectSecurityFilter("low")');
  assert.equal(app.get("#filter-empty").hidden, false);
  run('selectSecurityFilter("all")');
  assert.ok(app.list.children.every((card) => !card.hidden));
  assert.equal(app.get("#filter-empty").hidden, true);
  run("hasLoaded = false; applySecurityFilter()");
  assert.ok(app.buttons.every((button) => button.disabled));
  assert.equal(setup({ saved: "null" }).run("selectedFilter"), "null");
  assert.equal(setup({ saved: "invalid" }).run("selectedFilter"), "all");
  const blocked = setup({ storageBlocked: true });
  blocked.run('selectSecurityFilter("high")');
  assert.equal(blocked.run("selectedFilter"), "high");

  // Render fields, station/copy controls, and source labels without a browser.
  const fields = new Map();
  const field = (key) => { if (!fields.has(key)) fields.set(key, node()); return fields.get(key); };
  app.get("#incursion-template").content = { cloneNode: () => ({ querySelector: field }) };
  const item = { constellation_id: 99, staging_solar_system_id: 1, infested_solar_systems: [1, 1, 2], state: "withdrawing", influence: 0.5, has_boss: false };
  app.context.fixture = item;
  run('renderIncursion(fixture, new Map([[1, "Sakhti"], [2, "Other"]]), {state:"withdrawing", changedAt:Date.now(), source:"local"})');
  assert.equal(field(".incursion-card").dataset.area, "high");
  assert.equal(field(".incursion-card").dataset.state, "withdrawing");
  assert.equal(field(".space-pill").textContent, "High-sec");
  assert.equal(field(".infected-count").textContent, "2 systems");
  assert.match(field(".timing-note").textContent, /first seen in this browser/);
  const stagingGroup = field(".role-groups").children[0];
  const copyButton = stagingGroup.children[1].children[0].children[0];
  assert.equal(copyButton.dataset.systemName, "Sakhti");
  assert.match(copyButton.attrs["aria-label"], /NPC station present/);
  const unclassifiedGroup = field(".role-groups").children[1];
  assert.match(unclassifiedGroup.children[2].textContent, /reference data/);
  run('renderIncursion(fixture, new Map(), {state:"withdrawing", changedAt:Date.now(), source:"tracker"})');
  assert.match(field(".timing-note").textContent, /shared tracker/);
  assert.equal(field(".constellation-name").textContent, "Constellation 99");
  assert.equal(field(".type-line").textContent, "Region unavailable");
  run('renderIncursion(fixture, new Map(), {state:"withdrawing", changedAt:Date.now(), source:"tracker"}, {constellationName:"Mazake",regionId:10000043,regionName:"Domain"})');
  assert.equal(field(".constellation-name").textContent, "Mazake");
  assert.equal(field(".type-line").textContent, "Domain region");

  const places = setup();
  let calls = 0;
  places.context.fetch = async (url) => {
    calls++;
    return { ok: true, json: async () => String(url).includes("/constellations/")
      ? { name: "Mazake", region_id: 10000043 }
      : { name: "Domain" } };
  };
  let result = await places.run('getLocations([{constellation_id:99},{constellation_id:99}])');
  assert.equal(result.get(99).regionName, "Domain");
  await places.run('getLocations([{constellation_id:99}])');
  assert.equal(calls, 2, "Successful lookups should be reused during this page session");
  const partialPlaces = setup();
  partialPlaces.context.fetch = async (url) => {
    if (String(url).includes("/regions/")) throw Error("offline");
    return { ok: true, json: async () => ({ name: "Mazake", region_id: 10000043 }) };
  };
  result = await partialPlaces.run('getLocations([{constellation_id:99}])');
  assert.equal(result.get(99).constellationName, "Mazake");
  assert.equal(result.get(99).regionName, null);
  partialPlaces.context.fetch = async () => ({ ok: true, json: async () => ({ name: "Domain" }) });
  result = await partialPlaces.run('getLocations([{constellation_id:99}])');
  assert.equal(result.get(99).regionName, "Domain", "Failed region lookups must be retried");
  const unavailablePlaces = setup();
  result = await unavailablePlaces.run('getLocations([{constellation_id:99}])');
  assert.equal(result.size, 0);

  const offline = setup();
  await offline.run("loadIncursions()");
  assert.equal(offline.get("#status-title").textContent, "Unable to load incursions");
  assert.equal(offline.get("#refresh-button").disabled, false);
  assert.equal(offline.get("#filter-empty").hidden, true);
  const empty = setup();
  empty.context.fetch = async () => ({ ok: true, json: async () => [] });
  await empty.run("loadIncursions()");
  assert.equal(empty.get("#status-title").textContent, "No active incursions");
  assert.equal(empty.get("#filter-empty").hidden, true);
  const loaded = setup({ saved: "high" });
  loaded.context.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes("/incursions/")
      ? [item] : String(url).includes("/names/") ? [{ id: 1, name: "Sakhti" }]
        : { incursions: { 99: { active: true, constellation_id: 99, state: "withdrawing", state_changed_at: new Date().toISOString() } } },
  });
  loaded.run('renderIncursion = (item) => list.append({ dataset: { area: securityForSystem(item.staging_solar_system_id).area } })');
  await loaded.run("loadIncursions()");
  assert.equal(loaded.get("#status-title").textContent, "1 active incursion");
  assert.equal(loaded.list.children[0].hidden, false);
  assert.match(loaded.get("#status-detail").textContent, /Live ESI checked/);

  // The spawn clock must change phase at exactly 12/36 hours, and never guess
  // around missing history, a newer unknown-security end, or an active HS spawn.
  const hs = setup();
  const end = Date.now() - 3600000;
  hs.context.end = end;
  assert.equal(hs.run("highSecSpawnPhase(end, end).kind"), "cooldown");
  assert.equal(hs.run("highSecSpawnPhase(end, end + 12*3600000 - 1).kind"), "cooldown");
  assert.equal(hs.run("highSecSpawnPhase(end, end + 12*3600000).kind"), "window");
  assert.equal(hs.run("highSecSpawnPhase(end, end + 36*3600000).kind"), "overdue");
  assert.equal(hs.run("highSecSpawnPhase(NaN).kind"), "unavailable");
  assert.equal(hs.run("highSecSpawnPhase(Date.now() + 100000).kind"), "unavailable");
  assert.equal(await hs.run("getHighSecSpawnEstimate([{staging_solar_system_id:1}], null)"), null);
  assert.equal((await hs.run("getHighSecSpawnEstimate([], null)")).kind, "unavailable");
  hs.context.history = {
    20: { constellation_id:20, active:false, staging_solar_system_id:1, ended_at:new Date(end).toISOString() },
    21: { constellation_id:21, active:false, staging_solar_system_id:2, ended_at:new Date(end+1000).toISOString() },
  };
  result = await hs.run("getHighSecSpawnEstimate([], history)");
  assert.equal(result.endedAt, end, "A newer low-sec end must not reset the HS clock");
  hs.run("history[21].staging_solar_system_id = 999");
  assert.equal((await hs.run("getHighSecSpawnEstimate([], history)")).kind, "unavailable");
  hs.run("delete history[21]; history[20].active = true");
  assert.equal((await hs.run("getHighSecSpawnEstimate([], history)")).kind, "unavailable");
  hs.run("history[20].active = false; delete history[20].staging_solar_system_id; getUniverseRecord = async () => ({systems:[6]})");
  assert.equal((await hs.run("getHighSecSpawnEstimate([], history)")).endedAt, end, "Legacy records can resolve through ESI constellation data");
  hs.run("getUniverseRecord = async () => ({systems:[1,2]})");
  assert.equal((await hs.run("getHighSecSpawnEstimate([], history)")).kind, "unavailable");
  hs.run("spawnEstimate = {endedAt:end, checkedAt:Date.now()}; updateHighSecSpawnBanner()");
  assert.equal(hs.get("#hs-spawn-panel").dataset.phase, "cooldown");
  assert.match(hs.get("#hs-spawn-countdown").textContent, /^\d\d:\d\d:\d\d$/);
  hs.run("spawnEstimate = {endedAt:Date.now()-12*3600000, checkedAt:Date.now()}; updateHighSecSpawnBanner()");
  assert.equal(hs.get("#hs-spawn-panel").dataset.phase, "window");
  hs.run("spawnEstimate = {endedAt:Date.now()-36*3600000, checkedAt:Date.now()}; updateHighSecSpawnBanner()");
  assert.equal(hs.get("#hs-spawn-panel").dataset.phase, "overdue");
  hs.run("spawnEstimate = {endedAt:end, checkedAt:Date.now()-11*60000}; updateHighSecSpawnBanner()");
  assert.equal(hs.get("#hs-spawn-panel").dataset.phase, "unavailable");
  hs.run("spawnEstimate = null; updateHighSecSpawnBanner()");
  assert.equal(hs.get("#hs-spawn-panel").hidden, true);
  console.log("PASS: HS spawn phase boundaries, legacy history, stale data, active HS, and unknown security.");

  // Guard the HTML hooks used by the app and native accessibility semantics.
  for (const selector of source.matchAll(/document\.querySelector\("#([^"]+)"\)/g)) {
    assert.ok(html.includes('id="' + selector[1] + '"'), "Missing HTML hook: " + selector[1]);
  }
  assert.match(html, /aria-label="Filter by staging system security"/);
  assert.equal((html.match(/aria-pressed=/g) || []).length, 4);
  assert.match(html, /id="filter-empty"[^>]* hidden/);
  console.log("PASS: countdowns, security boundaries, filters, persistence, rendering, station/copy controls, network/empty/success states, and HTML hooks.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
