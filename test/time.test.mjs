import assert from "node:assert/strict";
import test from "node:test";

import {
  dayBounds,
  humanDuration,
  inZone,
  isoDurationToSeconds,
  parseDuration,
  parseInstant,
  resolveDate,
  shiftDate,
  toClockifyTime,
  wallClockToUtc,
} from "../dist/time.js";

test("converts local wall-clock time to UTC", () => {
  assert.equal(
    wallClockToUtc("2026-01-15T09:30:00", "Asia/Bishkek").toISOString(),
    "2026-01-15T03:30:00.000Z",
  );
});

test("parses common instant forms", () => {
  assert.equal(
    parseInstant("2026-08-05 09:00", "Asia/Bishkek").toISOString(),
    "2026-08-05T03:00:00.000Z",
  );
  assert.equal(
    parseInstant("09:15", "Asia/Bishkek", "2026-08-05").toISOString(),
    "2026-08-05T03:15:00.000Z",
  );
  assert.equal(
    parseInstant("2026-08-05T07:00:00Z", "Asia/Bishkek").toISOString(),
    "2026-08-05T07:00:00.000Z",
  );
});

test("handles calendar dates and day bounds", () => {
  assert.equal(resolveDate("2026-08-05", "UTC"), "2026-08-05");
  assert.equal(shiftDate("2026-08-05", -1), "2026-08-04");

  const bounds = dayBounds("2026-08-05", "Asia/Bishkek");
  assert.equal(bounds.start.toISOString(), "2026-08-04T18:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-05T18:00:00.000Z");
});

test("parses and formats durations", () => {
  assert.equal(parseDuration("2h30m"), 9000);
  assert.equal(parseDuration("PT1H15M"), 4500);
  assert.equal(parseDuration(90), 5400);
  assert.equal(isoDurationToSeconds("PT7H30M"), 27000);
  assert.equal(humanDuration(27000), "7h 30m");
});

test("formats Clockify and local display times", () => {
  const date = new Date("2026-08-05T03:15:12.345Z");
  assert.equal(toClockifyTime(date), "2026-08-05T03:15:12Z");
  assert.equal(inZone(date, "Asia/Bishkek"), "2026-08-05 09:15");
});
