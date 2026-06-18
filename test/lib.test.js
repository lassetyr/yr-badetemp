import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReading,
  parseLastReading,
  shouldAppend,
  formatLine,
} from "../scripts/lib.js";

const SAMPLE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        locationId: "0-10238",
        timestamp: "2026-06-18T18:38:27+02:00",
        timestampEpoch: 1781800707,
        waterTemperature: 16.6,
        airTemperature: 23.5,
        windSpeed: 0.8,
        windGust: 2.6,
        windDirection: 78,
      },
    },
    {
      type: "Feature",
      properties: {
        locationId: "0-10060",
        timestamp: "2026-06-18T18:21:40+02:00",
        timestampEpoch: 1781799700,
        waterTemperature: 17.8,
      },
    },
  ],
};

test("extractReading returns canonical reading for the matching spot", () => {
  const r = extractReading(SAMPLE, "0-10238");
  assert.deepEqual(r, {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  });
});

test("extractReading defaults missing optional fields to null", () => {
  const r = extractReading(SAMPLE, "0-10060");
  assert.equal(r.water, 17.8);
  assert.equal(r.air, null);
  assert.equal(r.windSpeed, null);
  assert.equal(r.windGust, null);
  assert.equal(r.windDir, null);
});

test("extractReading returns null when spot is absent", () => {
  assert.equal(extractReading(SAMPLE, "9-99999"), null);
});

test("extractReading returns null when geojson is malformed", () => {
  assert.equal(extractReading({}, "0-10238"), null);
  assert.equal(extractReading(null, "0-10238"), null);
});

test("parseLastReading returns null for empty text", () => {
  assert.equal(parseLastReading(""), null);
  assert.equal(parseLastReading("\n\n"), null);
});

test("parseLastReading returns the last line", () => {
  const text =
    '{"time":"a","epoch":1,"water":10,"air":null,"windSpeed":null,"windGust":null,"windDir":null}\n' +
    '{"time":"b","epoch":2,"water":11,"air":null,"windSpeed":null,"windGust":null,"windDir":null}\n';
  assert.equal(parseLastReading(text).epoch, 2);
});

test("shouldAppend is true when there is no prior reading", () => {
  assert.equal(shouldAppend(null, { epoch: 5 }), true);
});

test("shouldAppend is true only when the new epoch is strictly newer", () => {
  assert.equal(shouldAppend({ epoch: 5 }, { epoch: 6 }), true);
  assert.equal(shouldAppend({ epoch: 5 }, { epoch: 5 }), false);
  assert.equal(shouldAppend({ epoch: 5 }, { epoch: 4 }), false);
});

test("shouldAppend is false when there is no new reading", () => {
  assert.equal(shouldAppend({ epoch: 5 }, null), false);
});

test("formatLine round-trips through parseLastReading", () => {
  const reading = {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  };
  assert.equal(formatLine(reading).includes("\n"), false);
  assert.deepEqual(parseLastReading(formatLine(reading) + "\n"), reading);
});
