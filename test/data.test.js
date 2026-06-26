import { test } from "node:test";
import assert from "node:assert/strict";
import { readingsQueryUrl, latestReadingUrl, mapRow } from "../src/data.js";

const BASE = "https://proj.supabase.co";

test("readingsQueryUrl targets the readings endpoint, filters by location, orders newest-first", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "all", 1000));
  assert.equal(url.origin + url.pathname, `${BASE}/rest/v1/readings`);
  assert.equal(url.searchParams.get("location_id"), "eq.0-10238");
  // Newest-first so a future row cap would drop the oldest rows, not the tail.
  assert.equal(url.searchParams.get("order"), "epoch.desc");
  assert.equal(
    url.searchParams.get("select"),
    "time,epoch,water,air,wind_speed,wind_gust,wind_dir",
  );
});

test("readingsQueryUrl 'all' omits the epoch lower bound", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "all", 1000));
  assert.equal(url.searchParams.get("epoch"), null);
});

test("readingsQueryUrl unknown range omits the epoch lower bound", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "nope", 1000));
  assert.equal(url.searchParams.get("epoch"), null);
});

test("readingsQueryUrl '24h' sets epoch >= now - 24h", () => {
  const now = 1_000_000;
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "24h", now));
  assert.equal(url.searchParams.get("epoch"), `gte.${now - 24 * 3600}`);
});

test("readingsQueryUrl '7d' and '30d' use correct windows", () => {
  const now = 100 * 24 * 3600;
  const u7 = new URL(readingsQueryUrl(BASE, "0-10238", "7d", now));
  const u30 = new URL(readingsQueryUrl(BASE, "0-10238", "30d", now));
  assert.equal(u7.searchParams.get("epoch"), `gte.${now - 7 * 24 * 3600}`);
  assert.equal(u30.searchParams.get("epoch"), `gte.${now - 30 * 24 * 3600}`);
});

test("latestReadingUrl fetches the single newest reading regardless of range", () => {
  const url = new URL(latestReadingUrl(BASE, "0-10238"));
  assert.equal(url.origin + url.pathname, `${BASE}/rest/v1/readings`);
  assert.equal(url.searchParams.get("location_id"), "eq.0-10238");
  assert.equal(url.searchParams.get("order"), "epoch.desc");
  assert.equal(url.searchParams.get("limit"), "1");
  // No range bound — the header must reflect the true latest reading always.
  assert.equal(url.searchParams.get("epoch"), null);
});

test("mapRow converts snake_case columns to the camelCase reading shape", () => {
  const row = {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    wind_speed: 0.8,
    wind_gust: 2.6,
    wind_dir: 78,
  };
  assert.deepEqual(mapRow(row), {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  });
});
