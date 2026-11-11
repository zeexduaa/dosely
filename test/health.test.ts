import { test } from "node:test";
import assert from "node:assert/strict";
import * as h from "../src/health.js";
import { at, profileWith } from "./helpers.js";

test("reads readings as people type them", () => {
  assert.deepEqual(h.parseReading("bp", "128/82"), { kind: "bp", values: [128, 82], unit: "mmHg" });
  assert.deepEqual(h.parseReading("Blood-Pressure", "128 / 82"), { kind: "bp", values: [128, 82], unit: "mmHg" });
  assert.deepEqual(h.parseReading("sugar", "5.6", "mmol"), { kind: "glucose", values: [5.6], unit: "mmol/L" });
  assert.deepEqual(h.parseReading("weight", "81.4kg"), { kind: "weight", values: [81.4], unit: "kg" });
  assert.deepEqual(h.parseReading("temp", "100.4F"), { kind: "temperature", values: [100.4], unit: "F" });
  assert.deepEqual(h.parseReading("peak-flow", "420", "L/min"), { kind: "peak-flow", values: [420], unit: "L/min" });
});

test("refuses typos and mismatches with a reason", () => {
  assert.throws(() => h.parseReading("bp", "1280/82"), /looks like a typo \(expected 50 to 300\)/);
  assert.throws(() => h.parseReading("bp", "82/128"), /check the order/);
  assert.throws(() => h.parseReading("bp", "128"), /two numbers/);
  assert.throws(() => h.parseReading("glucose", "5.6", "kg"), /mg\/dL or mmol\/L/);
  assert.throws(() => h.parseReading("temperature", "98.6"), /looks like a typo/);       // °C by default
  assert.throws(() => h.parseReading("peak-flow", "420"), /give a unit/);
  assert.throws(() => h.parseReading("bp", "high"), /isn't a reading/);
});

test("targets flag readings outside the user's range", () => {
  const p = profileWith();
  p.targets.bp = h.parseTarget("bp", "90-130/60-85");
  p.targets.glucose = h.parseTarget("glucose", "4-");
  assert.equal(h.targetText(p.targets.bp), "90-130/60-85");
  const high = h.addMeasurement(p, h.parseReading("bp", "142/88"), at("2026-03-02 08:00"));
  assert.deepEqual(h.outsideTarget(p, high), ["systolic above 130", "diastolic above 85"]);
  const fine = h.addMeasurement(p, h.parseReading("glucose", "5.1", "mmol/L"), at("2026-03-02 08:00"));
  assert.deepEqual(h.outsideTarget(p, fine), []);
  assert.throws(() => h.parseTarget("bp", "90-130"), /2 parts/);
  assert.throws(() => h.parseTarget("glucose", "7-4"), /low end is above/);
});

test("summaries per kind, with change over the period", () => {
  const p = profileWith();
  p.targets.bp = h.parseTarget("bp", "-130/-85");
  const readings = ["140/90", "136/88", "130/84", "126/80"];
  readings.forEach((r, i) => h.addMeasurement(p, h.parseReading("bp", r), at(`2026-03-0${i + 1} 08:00`)));
  h.addMeasurement(p, h.parseReading("weight", "80", "kg"), at("2026-03-01 07:00"));
  h.addMeasurement(p, h.parseReading("weight", "176", "lb"), at("2026-03-02 07:00"));   // different unit: kept apart
  const [bp, ...weights] = h.summarize(p, at("2026-03-01 00:00"), at("2026-03-05 00:00"));
  assert.equal(bp!.count, 4);
  assert.deepEqual(bp!.values.map((v) => [v.name, v.average, v.min, v.max, v.change]),
    [["systolic", 133, 126, 140, -10], ["diastolic", 85.5, 80, 90, -7]]);
  assert.equal(bp!.outside, 2);
  assert.equal(h.formatReading(bp!.latest), "126/80 mmHg");
  assert.deepEqual(weights.map((w) => w.unit).sort(), ["kg", "lb"]);
});

test("symptoms", () => {
  const p = profileWith();
  h.addSymptom(p, "Headache", 6, at("2026-03-01 10:00"));
  h.addSymptom(p, "headache", 2, at("2026-03-03 10:00"), "after coffee");
  h.addSymptom(p, "nausea", 3, at("2026-03-02 10:00"));
  const [headache, nausea] = h.summarizeSymptoms(p, 0, at("2026-04-01 00:00"));
  assert.deepEqual([headache!.name, headache!.count, headache!.averageSeverity, headache!.worst], ["headache", 2, 4, 6]);
  assert.equal(nausea!.count, 1);
  assert.throws(() => h.addSymptom(p, "pain", 11, 0), /0 \(none\) to 10/);
});
