import { test } from "node:test";
import assert from "node:assert/strict";
import * as doses from "../src/doses.js";
import { at, med, profileWith } from "./helpers.js";

test("statuses through the day", () => {
  const bp = med("Lisinopril", "daily 8am, 8pm");
  const p = profileWith(bp);
  const [from, to] = doses.dayBounds(p, "2026-03-02");
  const statuses = (now: string) => doses.agenda(p, from!, to!, at(now)).map((i) => i.status);
  assert.deepEqual(statuses("2026-03-02 07:00"), ["upcoming", "upcoming"]);
  assert.deepEqual(statuses("2026-03-02 08:30"), ["due", "upcoming"]);
  assert.deepEqual(statuses("2026-03-02 09:30"), ["missed", "upcoming"]);
  doses.logDose(p, bp, at("2026-03-02 09:30"));
  assert.deepEqual(statuses("2026-03-02 09:31"), ["taken", "upcoming"]);
  const [taken] = doses.agenda(p, from!, to!, at("2026-03-02 10:00"));
  assert.equal(taken!.minutesLate, 90);
});

test("taking picks the nearest open dose, and won't record one twice", () => {
  const m = med("Metformin", "daily 8am, 8pm");
  const p = profileWith(m);
  const first = doses.logDose(p, m, at("2026-03-02 19:10"));
  assert.equal(first.occurrence?.slot, "2026-03-02T20:00");
  // The next nearest open dose is now the morning one (11 hours earlier) rather than 20:00 again.
  const second = doses.logDose(p, m, at("2026-03-02 19:20"));
  assert.equal(second.occurrence?.slot, "2026-03-02T08:00");
  assert.throws(() => doses.logDose(p, m, at("2026-03-02 21:00"), { slot: "2026-03-02T20:00" }), /already recorded as taken/);
  assert.throws(() => doses.logDose(p, m, at("2026-03-02 08:00"), { at: at("2026-03-03 08:00") }), /in the future/);
});

test("skipping needs a scheduled dose; extra doses have no slot", () => {
  const m = med("Vitamin D", "daily 9am");
  const pain = med("Paracetamol", "as needed");
  const p = profileWith(m, pain);
  assert.equal(doses.logDose(p, m, at("2026-03-02 09:05"), { status: "skipped", note: "nauseous" }).record.slot, "2026-03-02T09:00");
  assert.equal(doses.logDose(p, pain, at("2026-03-02 12:00"), { amount: 2 }).record.slot, undefined);
  assert.throws(() => doses.logDose(p, pain, at("2026-03-02 13:00"), { status: "skipped" }), /no scheduled dose/);
});

test("stock goes down when taken and back up on undo", () => {
  const m = med("Levothyroxine", "daily 7am x2", { stock: { count: 10, updated: 0 } });
  const p = profileWith(m);
  doses.logDose(p, m, at("2026-03-02 07:00"));
  assert.equal(m.stock!.count, 8);
  doses.logDose(p, m, at("2026-03-03 07:00"), { status: "skipped" });
  assert.equal(m.stock!.count, 8);
  assert.equal(doses.undoLast(p, m, at("2026-03-03 08:00")).status, "skipped");
  assert.equal(doses.undoLast(p, m, at("2026-03-03 08:00")).status, "taken");
  assert.equal(m.stock!.count, 10);
  assert.throws(() => doses.undoLast(p, m, at("2026-03-03 08:00")), /nothing is recorded/);
});

test("what needs attention, and what's next", () => {
  const a = med("A", "daily 8am");
  const b = med("B", "daily 9am, 9pm");
  const p = profileWith(a, b);
  const now = at("2026-03-02 09:20");
  assert.deepEqual(doses.needsAttention(p, now).map((i) => `${i.med.name} ${i.occurrence.date} ${i.occurrence.time} ${i.status}`),
    ["B 2026-03-01 21:00 missed", "A 2026-03-02 08:00 missed", "B 2026-03-02 09:00 due"]);
  assert.deepEqual(doses.nextDoses(p, now).map((i) => `${i.med.name} ${i.occurrence.time}`), ["B 21:00", "A 08:00"]);
});


test("changing the schedule keeps the past judged by the old one", () => {
  const m = med("Metformin", "daily 8am");
  const p = profileWith(m);
  doses.logDose(p, m, at("2026-03-01 08:00"));
  doses.logDose(p, m, at("2026-03-02 08:00"));
  doses.changeRegimen(m, { ...m.regimen, schedule: { kind: "daily", doses: [{ time: "09:00", amount: 1 }, { time: "21:00", amount: 1 }] } },
                      "2026-03-03");
  assert.equal(m.previous!.length, 1);
  assert.equal(m.previous![0]!.end, "2026-03-02");
  const [from] = doses.dayBounds(p, "2026-03-01");
  const [, to] = doses.dayBounds(p, "2026-03-03");
  assert.deepEqual(doses.agenda(p, from!, to!, at("2026-03-03 22:30")).map((i) => `${i.occurrence.slot} ${i.status}`),
    ["2026-03-01T08:00 taken", "2026-03-02T08:00 taken", "2026-03-03T09:00 missed", "2026-03-03T21:00 missed"]);
  // A schedule that hasn't started yet is simply replaced.
  const later = med("B", "daily 8am", { regimen: { start: "2026-04-01" } });
  doses.changeRegimen(later, { ...later.regimen, schedule: { kind: "as-needed" } }, "2026-03-03");
  assert.equal(later.previous, undefined);
  assert.equal(later.regimen.schedule.kind, "as-needed");
});


test("doses from before a medication was added aren't counted as missed", () => {
  const m = med("Amoxicillin", "every 8 hours from 6am", { regimen: { start: "2026-03-02" }, created: at("2026-03-02 12:30") });
  const p = profileWith(m);
  const [from, to] = doses.dayBounds(p, "2026-03-02");
  assert.deepEqual(doses.agenda(p, from!, to!, at("2026-03-02 12:31")).map((i) => i.occurrence.time), ["14:00", "22:00"]);
  doses.logDose(p, m, at("2026-03-02 12:31"), { at: at("2026-03-02 06:10") });     // a backdated dose still shows
  assert.deepEqual(doses.agenda(p, from!, to!, at("2026-03-02 12:31")).map((i) => `${i.occurrence.time} ${i.status}`),
    ["06:00 taken", "14:00 upcoming", "22:00 upcoming"]);
});


test("a late dose answers the dose that was missed, not the next one", () => {
  const m = med("Metformin", "daily 8am, 8pm");
  const p = profileWith(m);
  // Forgot the 8am dose and took it at 2:30pm: that's the morning dose, taken late.
  assert.equal(doses.logDose(p, m, at("2026-03-02 14:30")).occurrence?.slot, "2026-03-02T08:00");
  // At 7:10pm the evening dose (50 minutes away) is the one being taken, a little early.
  assert.equal(doses.logDose(p, m, at("2026-03-02 19:10")).occurrence?.slot, "2026-03-02T20:00");
});

test("the dose due now wins over one coming up soon", () => {
  const m = med("Antibiotic", "every 2 hours from 8am");
  const p = profileWith(m);
  // 10:20: the 10:00 dose is due; 12:00 is within 2 hours but isn't the one being taken.
  assert.equal(doses.logDose(p, m, at("2026-03-01 10:20")).occurrence?.slot, "2026-03-01#1");
  // 11:30: 10:00 is done, 08:00 is missed; the 12:00 dose is coming up, so taking now is for 12:00.
  assert.equal(doses.logDose(p, m, at("2026-03-01 11:30")).occurrence?.slot, "2026-03-01#2");
});


test("undo takes back the record entered last, even if it was backdated", () => {
  const m = med("Vitamin D", "daily 9am", { stock: { count: 10, updated: 0 } });
  const p = profileWith(m);
  const now = at("2026-03-03 09:05");
  doses.logDose(p, m, now);                                         // today's dose
  doses.logDose(p, m, now, { at: at("2026-03-02 09:00") });        // then yesterday's, after the fact
  assert.equal(doses.undoLast(p, m, now).slot, "2026-03-02T09:00");
  assert.equal(p.doses.length, 1);
  assert.equal(p.doses[0]!.slot, "2026-03-03T09:00");
  assert.equal(m.stock!.count, 9);
});
