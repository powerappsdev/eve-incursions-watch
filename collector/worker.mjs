const ESI = "https://esi.evetech.net/latest/incursions/?datasource=tranquility";
const SEED = "https://raw.githubusercontent.com/powerappsdev/eve-incursions-watch/main/data/incursion-state.json";

export function transition(previous, live, now) {
  const next = structuredClone(previous);
  const active = new Set();
  for (const spawn of live) {
    const id = String(spawn.constellation_id);
    active.add(id);
    const old = next.incursions[id];
    const continuing = old?.active === true;
    next.incursions[id] = {
      ...(continuing ? old : {}),
      constellation_id: spawn.constellation_id,
      staging_solar_system_id: spawn.staging_solar_system_id,
      active: true,
      state: spawn.state,
      first_seen_at: continuing ? old.first_seen_at : now,
      state_changed_at: continuing && old.state === spawn.state ? old.state_changed_at : now,
      last_seen_at: now,
    };
  }
  for (const [id, record] of Object.entries(next.incursions)) {
    if (record.active && !active.has(id)) {
      record.active = false;
      record.ended_at = now;
      record.end_after = record.last_seen_at ?? previous.last_success_at ?? null;
      record.end_before = now;
      record.end_source = "ESI observation interval";
    }
  }
  next.last_success_at = now;
  next.updated_at = now;
  return next;
}

async function jsonFetch(url, headers = {}) {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(20000) });
  if (!response.ok && response.status !== 304) throw new Error(`Upstream HTTP ${response.status}`);
  return response;
}

export async function collect(env) {
  const row = await env.DB.prepare("SELECT revision, payload FROM history WHERE id = 1").first();
  let state;
  if (row) state = JSON.parse(row.payload);
  else {
    state = await (await jsonFetch(SEED)).json();
    if (!state?.incursions || typeof state.incursions !== "object") throw new Error("Invalid seed history");
    // Audited correction: the original Actions tracker noticed this end late.
    const yekti = state.incursions["20000511"];
    if (yekti?.ended_at === "2026-11-19T07:51:47Z") {
      yekti.ended_at = "2026-11-19T04:20:02Z";
      yekti.end_source = "https://eve-incursions.com/history (imported 2026-11-19)";
    }
    state.last_success_at = null;
  }
  if (Date.parse(state.next_check_at) > Date.now()) return;
  const response = await jsonFetch(ESI, state.etag ? { "If-None-Match": state.etag } : {});
  const now = new Date().toISOString();
  let next;
  if (response.status === 304) {
    next = structuredClone(state);
    next.last_success_at = now;
    for (const record of Object.values(next.incursions)) if (record.active) record.last_seen_at = now;
  } else {
    const live = await response.json();
    if (!Array.isArray(live) || live.some(s => !Number.isInteger(s.constellation_id) || !Number.isInteger(s.staging_solar_system_id) || !["mobilizing", "established", "withdrawing"].includes(s.state))) throw new Error("Invalid ESI response; history retained");
    next = transition(state, live, now);
  }
  next.etag = response.headers.get("etag") ?? state.etag;
  next.next_check_at = response.headers.get("expires");
  next.esi_last_modified = response.headers.get("last-modified");
  if (row) {
    const result = await env.DB.prepare("UPDATE history SET payload = ?, revision = revision + 1 WHERE id = 1 AND revision = ?").bind(JSON.stringify(next), row.revision).run();
    if (!result.meta.changes) throw new Error("Concurrent update; retry on next scheduled check");
  } else {
    await env.DB.prepare("INSERT OR IGNORE INTO history (id, revision, payload) VALUES (1, 1, ?)").bind(JSON.stringify(next)).run();
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env));
  },
  async fetch(request, env) {
    const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Type": "application/json" };
    if (request.method !== "GET" || !["/", "/state"].includes(new URL(request.url).pathname)) return new Response("Not found", { status: 404, headers });
    let row = await env.DB.prepare("SELECT payload FROM history WHERE id = 1").first();
    if (!row) {
      // One-time initialization only; ordinary reads never trigger ESI requests.
      try {
        await collect(env);
        row = await env.DB.prepare("SELECT payload FROM history WHERE id = 1").first();
      } catch (error) {
        console.error("Collector initialization failed", error.message);
      }
    }
    if (!row) return new Response(JSON.stringify({ error: "Collector initializing" }), { status: 503, headers });
    return new Response(row.payload, { headers });
  },
};
