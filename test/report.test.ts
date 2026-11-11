import { test } from "node:test";
import assert from "node:assert/strict";
import * as report from "../src/report.js";
import * as doses from "../src/doses.js";
import * as h from "../src/health.js";
import { addRule } from "../src/safety.js";
import { at, med, profileWith } from "./helpers.js";

function sample() {
  const bp = med("Lisinopril", "daily 8am", { strength: "10 mg", purpose: "blood pressure", prescriber: "Dr Khan",
                                              stock: { count: 3, updated: 0 } });
  const pain = med("Paracetamol", "as needed", { strength: "500 mg" });
  const calcium = med("Calcium", "daily 6pm");
  const p = profileWith(bp, pain, calcium);
  p.name = "Ada";
  addRule(p, bp, calcium, 2, "pharmacist's advice");
  doses.logDose(p, bp, at("2026-03-01 08:05"));
  doses.logDose(p, bp, at("2026-03-02 08:00"), { status: "skipped", note: "felt dizzy" });
  doses.logDose(p, calcium, at("2026-03-01 18:00"));
  doses.logDose(p, pain, at("2026-03-02 10:00"), { amount: 2 });
  doses.logDose(p, pain, at("2026-03-02 16:00"), { amount: 2 });
  p.targets.bp = h.parseTarget("bp", "-130/-85");
  h.addMeasurement(p, h.parseReading("bp", "142/90"), at("2026-03-01 07:30"), "<b>after stairs</b>");
  h.addMeasurement(p, h.parseReading("bp", "128/80"), at("2026-03-02 07:30"));
  h.addSymptom(p, "headache", 4, at("2026-03-02 11:00"));
  return p;
}

test("the report covers medicines, adherence, as-needed use, readings and symptoms", () => {
  const p = sample();
  const r = report.build(p, "2026-03-01", "2026-03-02", at("2026-03-03 09:00"));
  assert.equal(r.title, "Health summary: Ada");
  assert.match(r.subtitle, /personal record, not a medical record/);
  const titles = r.sections.map((s) => s.title);
  assert.deepEqual(titles, ["Current medications", "Doses taken", "As-needed medications", "Measurements",
    "Readings outside target (latest 10)", "Symptoms", "Notes on doses", "Timing rules I follow", "Refills needed"]);
  const meds = r.sections[0]!.table!;
  assert.deepEqual(meds.rows[0], ["Lisinopril 10 mg", "once a day: 1 tablet at 08:00", "blood pressure", "", "Dr Khan", "2026-03-01"]);
  const taken = r.sections[1]!;
  assert.match(taken.text![0]!, /^Overall: 50% of 4 scheduled doses taken/);
  assert.deepEqual(r.sections[2]!.table!.rows[0], ["Paracetamol 500 mg", "2", "4 tablet(s)", "4"]);
  assert.match(r.sections[4]!.text![0]!, /142\/90 mmHg \(systolic above 130, diastolic above 85\)/);
  assert.match(r.sections[6]!.text![0]!, /Lisinopril 10 mg skipped – felt dizzy/);
});

test("markdown and HTML output, with HTML escaped", () => {
  const r = report.build(sample(), "2026-03-01", "2026-03-02", at("2026-03-03 09:00"));
  const md = report.toMarkdown(r);
  assert.match(md, /^# Health summary: Ada/);
  assert.match(md, /\| Medication \| How it's taken \|/);
  const html = report.toHtml(r);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes("&lt;b&gt;after stairs&lt;/b&gt;"));
  assert.ok(!html.includes("<b>after stairs</b>"));
  assert.match(html, /@media print/);
});

test("CSV exports quote properly and defuse formulas", () => {
  assert.equal(report.csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
  assert.equal(report.csvCell("-5"), "-5");
  assert.equal(report.csvCell("a, b"), `"a, b"`);
  assert.equal(report.csvCell(12.5), "12.5");
  const p = sample();
  const lines = report.dosesCsv(p).trim().split("\n");
  assert.equal(lines[0], "date,time,medication,status,amount,unit,scheduled_for,note");
  assert.equal(lines[1], "2026-03-01,08:05,Lisinopril 10 mg,taken,1,tablet,2026-03-01 08:00,");
  assert.ok(lines.some((l) => l.endsWith(",felt dizzy")));
  assert.match(report.measurementsCsv(p), /2026-03-01,07:30,bp,142\/90,mmHg,<b>after stairs<\/b>/);
  assert.match(report.symptomsCsv(p), /2026-03-02,11:00,headache,4,/);
});


test("CSV shows when every-N-hours doses were due, not an internal slot name", () => {
  const abx = med("Amoxicillin", "every 8 hours from 6am");
  const p = profileWith(abx);
  doses.logDose(p, abx, at("2026-03-01 14:20"));
  const line = report.dosesCsv(p).trim().split("\n")[1]!;
  assert.equal(line, "2026-03-01,14:20,Amoxicillin,taken,1,tablet,2026-03-01 14:00,");
});
