import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNdjson, filterByRange } from "../src/data.js";

const mk = (epoch) => ({
  time: new Date(epoch * 1000).toISOString(),
  epoch,
  water: 16,
  air: 20,
  windSpeed: 1,
  windGust: 2,
  windDir: 90,
});

test("parseNdjson returns [] for empty text", () => {
  assert.deepEqual(parseNdjson(""), []);
  assert.deepEqual(parseNdjson("\n  \n"), []);
});

test("parseNdjson parses multiple lines in order", () => {
  const text = JSON.stringify(mk(1)) + "\n" + JSON.stringify(mk(2)) + "\n";
  const out = parseNdjson(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].epoch, 1);
  assert.equal(out[1].epoch, 2);
});

test("filterByRange 'all' returns every reading", () => {
  const readings = [mk(100), mk(200)];
  assert.equal(filterByRange(readings, "all", 1000).length, 2);
});

test("filterByRange unknown key returns every reading", () => {
  const readings = [mk(100), mk(200)];
  assert.equal(filterByRange(readings, "nope", 1000).length, 2);
});

test("filterByRange '24h' keeps only readings within the last 24h", () => {
  const now = 1_000_000;
  const day = 24 * 3600;
  const readings = [mk(now - day - 10), mk(now - 10), mk(now)];
  const out = filterByRange(readings, "24h", now);
  assert.equal(out.length, 2);
  assert.equal(out[0].epoch, now - 10);
});

test("filterByRange '7d' and '30d' use correct windows", () => {
  const now = 100 * 24 * 3600;
  const within7 = now - 6 * 24 * 3600;
  const within30 = now - 20 * 24 * 3600;
  const old = now - 40 * 24 * 3600;
  const readings = [mk(old), mk(within30), mk(within7), mk(now)];
  assert.equal(filterByRange(readings, "7d", now).length, 2);
  assert.equal(filterByRange(readings, "30d", now).length, 3);
});
