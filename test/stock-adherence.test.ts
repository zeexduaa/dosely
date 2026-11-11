import { test } from "node:test";
import assert from "node:assert/strict";
import * as doses from "../src/doses.js";
import * as stock from "../src/stock.js";
import { adherence } from "../src/adherence.js";
import { at, med, profileWith } from "./helpers.js";

test("days of supply and refill warnings", () => {
  const a = med("A", "daily 8am, 8pm", { stock: { count: 9, updated: 0 } });
  const b = med("B", "daily 8am", { stock: { count: 60, updated: 0 } });
  const c = med("C", "daily 8am");                                   // stock not tracked
  const p = profileWith(a, b, c);
  const now = at("2026-03-02 12:00");
  assert.deepEqual(stock.supply(p, a, now), { med: a, count: 9, perDay: 2, daysLeft: 4, runsOut: "2026-03-06", low: true });
  assert.equal(stock.supply(p, c, now), undefined);
  assert.deepEqual(stock.refillsNeeded(p, now).map((s) => s.med.name), ["A"]);
  assert.equal(stock.supplyText(stock.supply(p, a, now)!), "A: 9 tablet(s) left, about 4 days (runs out 2026-03-06)");
  stock.addStock(a, 30, now);
  assert.equal(a.stock!.count, 39);
  assert.throws(() => stock.setStock(a, -1, now), /between 0/);
});

test("as-needed supply uses the last 30 days", () => {
  const pain = med("Paracetamol", "as needed", { stock: { count: 20, updated: 0 } });
  const p = profileWith(pain);
  for (let day = 1; day <= 10; day++) doses.logDose(p, pain, at(`2026-03-${String(day).padStart(2, "0")} 09:00`), { amount: 3 });
  const s = stock.supply(p, pain, at("2026-03-10 12:00"))!;
  assert.equal(s.count, 0);
  assert.equal(s.perDay, 1);
  assert.equal(s.low, true);
});

test("adherence counts on time, late, skipped and missed, and ignores what's not over", () => {
  const m = med("A", "daily 8am, 8pm");
  const p = profileWith(m);
  doses.logDose(p, m, at("2026-03-01 08:10"));                     // on time
  doses.logDose(p, m, at("2026-03-01 22:30"));                     // late (2.5 h)
  doses.logDose(p, m, at("2026-03-02 08:00"), { status: "skipped" });
  // 2026-03-02 20:00: missed. 2026-03-03 08:00 taken; 20:00 not yet due at "now".
  doses.logDose(p, m, at("2026-03-03 08:05"));
  const report = adherence(p, "2026-03-01", "2026-03-03", at("2026-03-03 12:00"));
  assert.deepEqual({ ...report.total }, { scheduled: 5, onTime: 2, late: 1, skipped: 1, missed: 1, percent: 60, onTimePercent: 40 });
  assert.deepEqual(report.days.map((d) => d.complete), [true, false, true]);
  assert.equal(report.streak, 1);
  assert.equal(report.meds[0]!.percent, 60);
});

test("a full week in a row is a streak; nothing due means no percentage", () => {
  const m = med("A", "daily 8am");
  const p = profileWith(m);
  for (let day = 1; day <= 7; day++) doses.logDose(p, m, at(`2026-03-0${day} 08:00`));
  assert.equal(adherence(p, "2026-03-01", "2026-03-07", at("2026-03-07 20:00")).streak, 7);
  assert.equal(adherence(p, "2026-02-01", "2026-02-02", at("2026-03-07 20:00")).total.percent, undefined);
});
