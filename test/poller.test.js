import { test } from "node:test";
import assert from "node:assert/strict";
import { runPoll } from "../scripts/poller.js";

const CFG = { yrApiKey: "yr-key", supabaseUrl: "https://db.example", supabaseServiceKey: "sb_secret_x" };
const silent = { log() {}, error() {} };

const waterJson = [0, 1, 2, 3, 4].map((i) => ({
  time: new Date(Date.UTC(2026, 10, 3, 12, i * 10)).toISOString(),
  temperature: 9 + i / 10,
}));
const metJson = {
  properties: {
    timeseries: Array.from({ length: 60 }, (_, h) => ({
      time: new Date(Date.UTC(2026, 10, 3, 13 + h)).toISOString(),
      data: { instant: { details: { air_temperature: 6, wind_speed: 3, wind_from_direction: 200 } } },
    })),
  },
};
// Recent history in the DB's snake_case shape, newest-first like the real query.
const historyRows = Array.from({ length: 300 }, (_, i) => ({
  epoch: Date.UTC(2026, 10, 3, 12, 40) / 1000 - i * 600,
  water: 9.4,
  air: 6,
  wind_speed: 3,
  wind_dir: 200,
}));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Fake fetch routing each endpoint the poll calls; records every request.
function fakeFetch({ met = () => json(metJson), insertEcho = (rows) => rows.slice(-1) } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: opts.method ?? "GET", headers: opts.headers ?? {}, body });
    if (u.startsWith("https://badetemperaturer.yr.no/")) return json(waterJson);
    if (u.startsWith("https://api.met.no/")) return met();
    if (u.startsWith(`${CFG.supabaseUrl}/rest/v1/readings?`)) return json(historyRows);
    if (u === `${CFG.supabaseUrl}/rest/v1/readings`) return json(insertEcho(body), 201);
    if (u.startsWith(`${CFG.supabaseUrl}/rest/v1/forecast`)) return new Response(null, { status: 201 });
    return new Response("unexpected", { status: 500 });
  };
  return { fn, calls };
}

test("runPoll inserts all five readings and refreshes the forecast", async () => {
  const f = fakeFetch();
  const summary = await runPoll({ ...CFG, fetch: f.fn, log: silent });

  const water = f.calls.find((c) => c.url.includes("badetemperaturer"));
  assert.equal(water.headers.apikey, "yr-key");

  const insert = f.calls.find((c) => c.url === "https://db.example/rest/v1/readings");
  assert.equal(insert.method, "POST");
  assert.equal(insert.headers.Authorization, "Bearer sb_secret_x");
  assert.match(insert.headers.Prefer, /resolution=ignore-duplicates/);
  assert.equal(insert.body.length, 5);
  assert.equal(insert.body[0].location_id, "0-10238");
  assert.equal(insert.body[4].air, 6);

  assert.ok(f.calls.some((c) => c.url === "https://db.example/rest/v1/forecast" && c.method === "POST"));
  assert.ok(f.calls.some((c) => c.url === "https://db.example/rest/v1/forecast_archive" && c.method === "POST"));
  assert.deepEqual(
    { fetched: summary.fetched, inserted: summary.inserted, latest: summary.latest },
    { fetched: 5, inserted: 1, latest: waterJson[4].time },
  );
  assert.ok(summary.projection.points > 1);
});

test("runPoll without YR_API_KEY makes no requests", async () => {
  const f = fakeFetch();
  const summary = await runPoll({ ...CFG, yrApiKey: undefined, fetch: f.fn, log: silent });
  assert.equal(f.calls.length, 0);
  assert.equal(summary.fetched, 0);
});

test("runPoll still inserts water-only rows when met.no is down", async () => {
  const f = fakeFetch({ met: () => new Response("down", { status: 503 }) });
  const summary = await runPoll({ ...CFG, fetch: f.fn, log: silent });
  const insert = f.calls.find((c) => c.url === "https://db.example/rest/v1/readings");
  assert.equal(insert.body.length, 5);
  assert.ok(insert.body.every((r) => r.air === null));
  assert.equal(summary.projection, null); // no forecast series → no projection
  assert.ok(!f.calls.some((c) => c.url.endsWith("/rest/v1/forecast")));
});
