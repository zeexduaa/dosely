import { test } from "node:test";
import assert from "node:assert/strict";
import * as doses from "../src/doses.js";
import * as safety from "../src/safety.js";
import { at, med, profileWith } from "./helpers.js";

test("the daily maximum blocks unless forced, and says when it's fine again", () => {
  const pain = med("Paracetamol", "as needed", { strength: "500 mg", limits: { maxPerDay: 8, minHoursBetween: 4 } });
  const p = profileWith(pain);
  for (const time of ["2026-03-02 06:00", "2026-03-02 10:00", "2026-03-02 14:00"]) doses.logDose(p, pain, at(time), { amount: 2 });
  doses.logDose(p, pain, at("2026-03-02 18:00"), { amount: 2 });
  assert.throws(() => doses.logDose(p, pain, at("2026-03-02 22:00"), { amount: 2 }),
    /10 tablet\(s\) of Paracetamol 500 mg in 24 hours; your limit is 8. The next dose fits the limit from 2026-03-03 06:00.*--force/);
  const forced = doses.logDose(p, pain, at("2026-03-02 22:00"), { amount: 2, force: true });
  assert.equal(forced.warnings[0]!.kind, "max-per-day");
  assert.equal(doses.logDose(p, pain, at("2026-03-03 18:30"), { amount: 1 }).warnings.length, 0);
});

test("too soon is a warning, not a block", () => {
  const pain = med("Ibuprofen", "as needed", { limits: { minHoursBetween: 6 } });
  const p = profileWith(pain);
  doses.logDose(p, pain, at("2026-03-02 08:00"));
  const result = doses.logDose(p, pain, at("2026-03-02 11:30"));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!.message, /3.5 hours ago.*from 2026-03-02 14:00/);
});

test("separation rules warn when two medicines are taken too close", () => {
  const thyroid = med("Levothyroxine", "daily 7am");
  const calcium = med("Calcium", "daily 8am");
  const p = profileWith(thyroid, calcium);
  safety.addRule(p, thyroid, calcium, 4, "calcium blocks absorption");
  assert.equal(p.rules.length, 1);
  safety.addRule(p, calcium, thyroid, 4);                     // same pair: updated, not duplicated
  assert.equal(p.rules.length, 1);
  doses.logDose(p, thyroid, at("2026-03-02 07:00"));
  const result = doses.logDose(p, calcium, at("2026-03-02 08:00"));
  assert.match(result.warnings[0]!.message, /Levothyroxine was taken at 2026-03-02 07:00; your rule says keep it and Calcium 4 hours apart \(calcium blocks absorption\)/);
  assert.throws(() => safety.addRule(p, thyroid, thyroid, 4), /two different/);
});

test("the schedule check finds regular times that break a rule", () => {
  const thyroid = med("Levothyroxine", "daily 7am");
  const calcium = med("Calcium", "daily 8am, 6pm");
  const p = profileWith(thyroid, calcium);
  safety.addRule(p, thyroid, calcium, 4);
  const conflicts = safety.scheduleConflicts(p, at("2026-03-02 12:00"));
  assert.deepEqual(conflicts.map((c) => [c.times, c.hoursApart]), [[["07:00", "08:00"], 1]]);
});
