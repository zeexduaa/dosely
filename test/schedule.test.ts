import { test } from "node:test";
import assert from "node:assert/strict";
import * as s from "../src/schedule.js";
import { toInstant } from "../src/time.js";

const LONDON = "Europe/London";
const day = (date: string, zone = LONDON) => [toInstant(date, "00:00", zone), toInstant(date, "23:59", zone) + 60_000];
const between = (r: s.Regimen, from: string, to: string) =>
  s.occurrences(r, toInstant(from, "00:00", r.zone), toInstant(to, "00:00", r.zone));
const regimen = (text: string, extra: Partial<s.Regimen> = {}): s.Regimen =>
  s.validate({ schedule: s.parseSchedule(text), start: "2026-03-01", zone: LONDON, ...extra });

test("parses the short forms", () => {
  assert.deepEqual(s.parseSchedule("daily 8am, 8pm"), { kind: "daily", doses: [{ time: "08:00", amount: 1 }, { time: "20:00", amount: 1 }] });
  assert.deepEqual(s.parseSchedule("8:00 x2 and 20:00"), { kind: "daily", doses: [{ time: "08:00", amount: 2 }, { time: "20:00", amount: 1 }] });
  assert.deepEqual(s.parseSchedule("Mon, Wed,friday 9:00"), { kind: "weekdays", days: ["mon", "wed", "fri"], doses: [{ time: "09:00", amount: 1 }] });
  assert.equal(s.parseSchedule("weekdays 7am").kind, "weekdays");
  assert.deepEqual(s.parseSchedule("every other day 8am"), { kind: "every-days", every: 2, doses: [{ time: "08:00", amount: 1 }] });
  assert.deepEqual(s.parseSchedule("every 8 hours from 6am x2"), { kind: "every-hours", every: 8, first: "06:00", amount: 2 });
  assert.deepEqual(s.parseSchedule("21 on 7 off 9pm"), { kind: "cycle", on: 21, off: 7, doses: [{ time: "21:00", amount: 1 }] });
  assert.deepEqual(s.parseSchedule("21 days on, 7 days off 9pm").kind, "cycle");
  assert.deepEqual(s.parseSchedule("PRN"), { kind: "as-needed" });
  assert.throws(() => s.parseSchedule("whenever I remember"), /can't read the schedule/);
});

test("validation explains what's wrong", () => {
  assert.throws(() => regimen("daily 8am, 08:00"), /listed twice/);
  assert.throws(() => regimen("every 0 days 8am"), /from 1 to 365/);
  assert.throws(() => regimen("daily 8am x0"), /above 0/);
  assert.throws(() => regimen("daily 8am", { end: "2026-02-01" }), /before the start date/);
  assert.throws(() => regimen("as needed", { taper: [{ days: 2, amount: 1 }] }), /can't have a taper/);
});

test("daily and weekday schedules", () => {
  const twice = regimen("daily 8pm, 8am");
  assert.deepEqual(twice.schedule.kind === "daily" && twice.schedule.doses.map((d) => d.time), ["08:00", "20:00"]);
  const doses = between(twice, "2026-03-02", "2026-03-04");
  assert.deepEqual(doses.map((d) => d.slot), ["2026-03-02T08:00", "2026-03-02T20:00", "2026-03-03T08:00", "2026-03-03T20:00"]);
  const mwf = regimen("mon,wed,fri 9:00");                       // 2026-03-02 is a Monday
  assert.deepEqual(between(mwf, "2026-03-02", "2026-03-09").map((d) => d.date), ["2026-03-02", "2026-03-04", "2026-03-06"]);
});

test("nothing before the start or after the end", () => {
  const r = regimen("daily 8am", { start: "2026-03-05", end: "2026-03-06" });
  assert.deepEqual(between(r, "2026-03-01", "2026-03-31").map((d) => d.date), ["2026-03-05", "2026-03-06"]);
});

test("every N days and cycles count from the start", () => {
  const r = regimen("every 3 days 8am");
  assert.deepEqual(between(r, "2026-03-01", "2026-03-11").map((d) => d.date), ["2026-03-01", "2026-03-04", "2026-03-07", "2026-03-10"]);
  const pill = regimen("3 on 2 off 9pm");
  assert.deepEqual(between(pill, "2026-03-01", "2026-03-11").map((d) => d.date),
    ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-06", "2026-03-07", "2026-03-08"]);
});

test("clock times stay put when daylight saving starts and ends", () => {
  const r = regimen("daily 8am");
  for (const date of ["2026-03-28", "2026-03-29", "2026-03-30", "2026-10-25", "2026-10-26"]) {
    const [from, to] = day(date);
    const [dose] = s.occurrences(r, from!, to!);
    assert.equal(dose?.time, "08:00", date);
  }
  // A dose at 01:30 on the spring-change night still happens (at 02:30), and isn't doubled in autumn.
  const night = regimen("daily 1:30am");
  assert.equal(s.occurrences(night, ...(day("2026-03-29") as [number, number])).length, 1);
  assert.equal(s.occurrences(night, ...(day("2026-10-25") as [number, number])).length, 1);
});

test("every N hours counts real hours across a clock change", () => {
  const r = regimen("every 8 hours from 6am", { start: "2026-03-28" });
  const doses = between(r, "2026-03-28", "2026-03-30");
  assert.deepEqual(doses.map((d) => `${d.date} ${d.time}`),
    ["2026-03-28 06:00", "2026-03-28 14:00", "2026-03-28 22:00", "2026-03-29 07:00", "2026-03-29 15:00", "2026-03-29 23:00"]);
  for (let i = 1; i < doses.length; i++) assert.equal(doses[i]!.instant - doses[i - 1]!.instant, 8 * 3_600_000);
  assert.equal(new Set(doses.map((d) => d.slot)).size, doses.length);
});

test("tapers change the amount and end the regimen", () => {
  const r = regimen("daily 8am", { taper: [{ days: 2, amount: 4 }, { days: 3, amount: 2 }, { days: 1, amount: 1 }] });
  assert.equal(s.lastDay(r), "2026-03-06");
  assert.deepEqual(between(r, "2026-03-01", "2026-03-31").map((d) => d.amount), [4, 4, 2, 2, 2, 1]);
});

test("units per day for refill forecasts", () => {
  assert.equal(s.unitsPerDay(regimen("daily 8am x2, 8pm"), "2026-03-01"), 3);
  assert.equal(s.unitsPerDay(regimen("mon,wed,fri 9:00"), "2026-03-01"), 3 / 7);
  assert.equal(s.unitsPerDay(regimen("every 6 hours from 6am"), "2026-03-01"), 4);
  assert.equal(s.unitsPerDay(regimen("21 on 7 off 9pm"), "2026-03-01"), 0.75);
  assert.equal(s.unitsPerDay(regimen("as needed"), "2026-03-01"), 0);
});

test("descriptions read naturally", () => {
  assert.equal(s.describe(regimen("daily 8am, 8pm"), "tablet"), "twice a day: 1 tablet at 08:00 and 20:00");
  assert.equal(s.describe(regimen("daily 8am x2, 2pm, 8pm"), "tablet"),
    "three times a day: at 08:00 (2 tablets), 14:00 (1 tablet) and 20:00 (1 tablet)");
  assert.equal(s.describe(regimen("every other day 9am"), "capsule"), "every other day, once that day: 1 capsule at 09:00");
  assert.equal(s.describe(regimen("every 8 hours from 6am"), "ml"), "every 8 hours from 06:00: 1 ml");
  assert.equal(s.describe(regimen("daily 8am", { end: "2026-03-10" }), "puff"), "once a day: 1 puff at 08:00; until 2026-03-10");
  assert.equal(s.describe(regimen("daily 8am", { taper: [{ days: 3, amount: 2 }, { days: 3, amount: 1 }] }), "tablet"),
    "once a day: 1 tablet at 08:00; tapering 2 for 3 days, then 1 for 3 days; until 2026-03-06");
  assert.equal(s.amountText(2, "drop"), "2 drops");
  assert.equal(s.amountText(5, "ml"), "5 ml");
});
