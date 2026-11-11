import { test } from "node:test";
import assert from "node:assert/strict";
import * as t from "../src/time.js";

test("parses dates and rejects impossible ones", () => {
  assert.equal(t.parseDate("2026-03-29"), "2026-03-29");
  assert.equal(t.parseDate(" 2028-02-29 "), "2028-02-29");
  assert.throws(() => t.parseDate("2027-02-29"), /isn't a real date/);
  assert.throws(() => t.parseDate("29/03/2026"), /YYYY-MM-DD/);
});

test("parses times in 24-hour and am/pm forms", () => {
  assert.deepEqual(["8:00", "08:05", "23:59", "8am", "8:30 PM", "12am", "12pm", "noon", "midnight"].map(t.parseTime),
    ["08:00", "08:05", "23:59", "08:00", "20:30", "00:00", "12:00", "12:00", "00:00"]);
  for (const bad of ["24:00", "8:60", "13pm", "0am", "eight"]) assert.throws(() => t.parseTime(bad), t.TimeError, bad);
});

test("date arithmetic", () => {
  assert.equal(t.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(t.addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(t.daysBetween("2026-01-01", "2027-01-01"), 365);
  assert.equal(t.weekday("2026-11-11"), "wed");
  assert.deepEqual([...t.dateRange("2026-01-30", "2026-02-02")], ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
});

test("wall-clock times round-trip through instants", () => {
  for (const zone of ["UTC", "Europe/London", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe", "Asia/Karachi"]) {
    for (const [date, time] of [["2026-01-15", "08:00"], ["2026-07-15", "21:45"], ["2026-11-11", "00:00"]] as const) {
      const instant = t.toInstant(date, time, zone);
      assert.equal(t.formatInstant(instant, zone), `${date} ${time}`, zone);
    }
  }
  assert.equal(t.toInstant("2026-07-01", "08:00", "Europe/London"), Date.UTC(2026, 6, 1, 7, 0));
  assert.equal(t.toInstant("2026-01-01", "08:00", "Asia/Kolkata"), Date.UTC(2026, 0, 1, 2, 30));
});

test("a time skipped by spring-forward moves forward by the gap", () => {
  // London: clocks go from 01:00 to 02:00 on 2026-03-29, so 01:30 doesn't exist.
  const instant = t.toInstant("2026-03-29", "01:30", "Europe/London");
  assert.equal(t.formatInstant(instant, "Europe/London"), "2026-03-29 02:30");
  // New York: 02:00 -> 03:00 on 2026-03-08.
  assert.equal(t.formatInstant(t.toInstant("2026-03-08", "02:15", "America/New_York"), "America/New_York"),
    "2026-03-08 03:15");
});

test("a time repeated by fall-back means the first one", () => {
  // London: 02:00 -> 01:00 on 2026-10-25, so 01:30 happens in BST and again in GMT.
  const instant = t.toInstant("2026-10-25", "01:30", "Europe/London");
  assert.equal(instant, Date.UTC(2026, 9, 25, 0, 30));          // 01:30 BST = 00:30 UTC
  assert.equal(t.offsetMinutes(instant, "Europe/London"), 60);
});

test("unknown zones are a clear error", () => {
  assert.throws(() => t.checkZone("Mars/Olympus"), /unknown time zone/);
  assert.equal(t.checkZone("Asia/Tokyo"), "Asia/Tokyo");
});
