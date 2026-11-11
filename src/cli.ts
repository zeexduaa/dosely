#!/usr/bin/env node
/**
 * The dosely command line. Run ``dosely help`` for the commands.
 *
 * Everything is in ``run(argv, context)``, with the clock, output and environment
 * passed in, so the whole command line can be tested without a real terminal.
 */

import { parseArgs } from "node:util";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VERSION } from "./version.js";
import * as store from "./store.js";
import { type Data, type Medication, type Profile, DataError, findMedication, findProfile, medLabel, medicationById,
         newId, newProfile } from "./model.js";
import { type Regimen, type TaperStep, ScheduleError, amountText, describe, parseSchedule, validate } from "./schedule.js";
import { TimeError, addDays, checkZone, formatInstant, localParts, parseDate, parseTime, systemZone, toInstant } from "./time.js";
import * as doses from "./doses.js";
import { addRule, scheduleConflicts } from "./safety.js";
import { addStock, refillsNeeded, setStock, supply, supplyText } from "./stock.js";
import { adherence } from "./adherence.js";
import * as health from "./health.js";
import * as report from "./report.js";
import { type Notifier, systemNotifier } from "./notify.js";

export interface Context {
  now(): number;
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  notify?: Notifier;
  sleep?: (ms: number) => Promise<void>;
}

class UsageError extends Error {
  override name = "UsageError";
}

const HELP = `dosely ${VERSION}: a private medication and health tracker

Getting started
  dosely init [--name NAME] [--zone ZONE]       create your data file
  dosely add NAME --schedule "daily 8am, 8pm"   add a medication (see "Adding" below)
  dosely                                        today's doses (same as: dosely today)

Every day
  dosely today                                  today's doses and what needs attention
  dosely take NAME [--at TIME] [--amount N] [--note TEXT] [--force]
  dosely take all                               take every dose that's due now
  dosely skip NAME [--note TEXT]                record a dose deliberately not taken
  dosely undo NAME                              remove the last record of a medication
  dosely due                                    what's due or missed (exit code 1 if anything)
  dosely watch [--once]                         desktop reminders when doses come due

Medications
  dosely list [--all]                           current (or all) medications
  dosely show NAME                              details, next dose, supply
  dosely edit NAME [options of add]             change details; a new --schedule applies from today
  dosely stop NAME / dosely restart NAME        stop taking it (history is kept) / take it again
  dosely stock [NAME [COUNT | +COUNT]]          supply on hand; +30 adds a refill
  dosely history [NAME] [--days N]              what was taken and skipped

Health
  dosely measure KIND VALUE [UNIT] [--at TIME] [--note TEXT]
                                                bp 128/82, glucose 5.6 mmol/L, weight 81 kg,
                                                temperature 37.8 C, pulse 72, spo2 97, or your own
  dosely measures [KIND] [--days N]             readings and averages
  dosely target KIND RANGE                      your doctor's target: bp 90-130/60-85, glucose 4-7
  dosely symptom NAME SEVERITY [--note TEXT]    severity 0 (none) to 10 (worst)
  dosely symptoms [--days N]

Safety
  dosely rule A B HOURS [--note TEXT]           keep two medications at least HOURS apart
  dosely rules                                  list rules and schedule clashes

Reports
  dosely adherence [--days N]                   how well the schedule was kept
  dosely report [--days N | --from DATE --to DATE] [--html FILE | --out FILE]
  dosely export doses|measurements|symptoms FILE.csv

Profiles (for looking after others)
  dosely profile                                list profiles
  dosely profile add NAME [--zone ZONE]         add one
  dosely profile use NAME                       make it the default
  dosely profile zone ZONE                      you've moved or are travelling: change the time zone
  --profile NAME                                use another profile for one command
  --file PATH                                   another data file (default: $DOSELY_FILE or your data folder)

Adding
  --schedule TEXT    "daily 8am, 8pm", "8am x2", "mon,wed,fri 9:00", "weekdays 7am", "every other day 8am",
                     "every 8 hours from 6am", "21 on 7 off 9pm", "as needed"
  --strength TEXT    "10 mg"            --unit WORD      tablet (default), capsule, ml, puff, drop...
  --for TEXT         what it's for      --instructions   "with food"     --prescriber, --pharmacy, --notes
  --start DATE       default today      --end DATE       last day         --stock N   units on hand
  --taper STEPS      "4x5,2x5,1x3": 4 units for 5 days, then 2 for 5, then 1 for 3
  --max-per-day N    for as-needed: at most N units in 24 hours (blocks more unless --force)
  --min-hours N      for as-needed: at least N hours between doses (warns)

dosely keeps your records on this computer only. It does not give medical advice:
limits and rules are the ones you enter from your label, doctor or pharmacist.`;

const MED_OPTIONS = {
  schedule: { type: "string", short: "s" }, strength: { type: "string" }, unit: { type: "string" },
  for: { type: "string" }, instructions: { type: "string" }, prescriber: { type: "string" }, pharmacy: { type: "string" },
  notes: { type: "string" }, start: { type: "string" }, end: { type: "string" }, stock: { type: "string" },
  taper: { type: "string" }, "max-per-day": { type: "string" }, "min-hours": { type: "string" }, name: { type: "string" },
} as const;

// -- small helpers ---------------------------------------------------------------------------------------

function number(text: string | undefined, what: string, { min = 0, integer = false } = {}): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new UsageError(`${what} must be ${integer ? "a whole number" : "a number"}${min > 0 ? ` of at least ${min}` : ""}, not "${text}"`);
  }
  return n;
}

export function parseTaper(text: string): TaperStep[] {
  return text.split(",").map((part) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*x\s*(\d+)\s*$/i.exec(part);
    if (!m) throw new UsageError(`"${part}" isn't a taper step; use AMOUNTxDAYS, like 4x5,2x5`);
    return { amount: Number(m[1]), days: Number(m[2]) };
  });
}

/** "8:15", "now", "yesterday 20:00", "2026-03-02 08:00", "30m ago", "2h ago". */
export function parseWhen(text: string, zone: string, now: number): number {
  const t = text.trim().toLowerCase();
  if (t === "now") return now;
  const ago = /^(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?)\s+ago$/.exec(t);
  if (ago) return now - Number(ago[1]) * (ago[2]!.startsWith("h") ? 3_600_000 : 60_000);
  const today = localParts(now, zone).date;
  const m = /^(?:(today|yesterday|\d{4}-\d{2}-\d{2})\s+)?(.+)$/.exec(t)!;
  const date = m[1] === "yesterday" ? addDays(today, -1) : m[1] && m[1] !== "today" ? parseDate(m[1]) : today;
  return toInstant(date, parseTime(m[2]!), zone);
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd());
}

const STATUS_MARK: Record<doses.SlotStatus, string> = {
  taken: "[x]", skipped: "[-]", missed: "[!]", due: "[ ]", upcoming: "[ ]",
};

// -- the commands --------------------------------------------------------------------------------------

interface Session {
  ctx: Context;
  path: string;
  data: Data;
  profile: Profile;
  dirty: boolean;
}

type Handler = (s: Session, args: string[]) => number | Promise<number>;

function opts<T extends Record<string, { type: "string" | "boolean"; short?: string }>>(args: string[], options: T) {
  return parseArgs({ args, options, allowPositionals: true, strict: true });
}

function regimenFrom(values: Record<string, string | boolean | undefined>, base: Partial<Regimen>, zone: string, today: string): Regimen {
  const schedule = values.schedule !== undefined ? parseSchedule(String(values.schedule)) : base.schedule;
  if (!schedule) throw new UsageError('give a schedule, like --schedule "daily 8am" (or --schedule "as needed")');
  const regimen: Regimen = { schedule, start: values.start ? parseDate(String(values.start)) : base.start ?? today, zone };
  const end = values.end !== undefined ? String(values.end) : base.end;
  if (end) regimen.end = parseDate(end);
  const taper = values.taper !== undefined ? parseTaper(String(values.taper)) : base.taper;
  if (taper) regimen.taper = taper;
  return validate(regimen);
}

function applyDetails(med: Medication, values: Record<string, string | boolean | undefined>): void {
  const text = (key: string, field: "strength" | "purpose" | "instructions" | "prescriber" | "pharmacy" | "notes") => {
    const v = values[key];
    if (typeof v === "string") {
      if (v.trim()) med[field] = v.trim(); else delete med[field];
    }
  };
  text("strength", "strength");
  text("for", "purpose");
  text("instructions", "instructions");
  text("prescriber", "prescriber");
  text("pharmacy", "pharmacy");
  text("notes", "notes");
  if (typeof values.unit === "string") {
    if (!/^[a-z][a-z ]{0,19}$/i.test(values.unit.trim())) throw new UsageError("the unit is a short word like tablet, ml or puff");
    med.unit = values.unit.trim().toLowerCase();
  }
  const max = number(values["max-per-day"] as string | undefined, "--max-per-day", { min: 0.01 });
  const minHours = number(values["min-hours"] as string | undefined, "--min-hours", { min: 0.1 });
  if (max !== undefined || minHours !== undefined) {
    med.limits = { ...med.limits };
    if (max !== undefined) med.limits.maxPerDay = max;
    if (minHours !== undefined) med.limits.minHoursBetween = minHours;
  }
}

const commands: Record<string, Handler> = {
  add(s, args) {
    const { values, positionals } = opts(args, MED_OPTIONS);
    const name = positionals.join(" ").trim();
    if (!name) throw new UsageError('give the medication a name: dosely add Lisinopril --schedule "daily 8am"');
    if (s.profile.medications.some((m) => !m.archived && m.name.toLowerCase() === name.toLowerCase())) {
      throw new UsageError(`${name} is already on the list; change it with: dosely edit ${name}`);
    }
    const now = s.ctx.now();
    const med: Medication = { id: newId(), name, unit: "tablet", created: now,
      regimen: regimenFrom(values, {}, s.profile.zone, doses.today(s.profile, now)) };
    applyDetails(med, values);
    const count = number(values.stock, "--stock");
    if (count !== undefined) setStock(med, count, now);
    s.profile.medications.push(med);
    s.dirty = true;
    s.ctx.out(`added ${medLabel(med)}: ${describe(med.regimen, med.unit)}`);
    const [next] = doses.nextDoses({ ...s.profile, medications: [med] }, now);
    if (next) s.ctx.out(`next dose: ${formatInstant(next.occurrence.instant, s.profile.zone)}`);
    return 0;
  },

  edit(s, args) {
    const { values, positionals } = opts(args, MED_OPTIONS);
    const med = findMedication(s.profile, positionals.join(" "));
    const now = s.ctx.now();
    const today = doses.today(s.profile, now);
    if (typeof values.name === "string" && values.name.trim()) med.name = values.name.trim();
    applyDetails(med, values);
    if ((["schedule", "start", "end", "taper"] as const).some((k) => values[k] !== undefined)) {
      const next = regimenFrom(values, med.regimen, med.regimen.zone, today);
      if (values.schedule !== undefined || values.taper !== undefined) {
        doses.changeRegimen(med, next, values.start ? next.start : today);
      } else {
        med.regimen = next;
      }
    }
    if (values.stock !== undefined) setStock(med, number(values.stock, "--stock")!, now);
    s.dirty = true;
    s.ctx.out(`updated ${medLabel(med)}: ${describe(med.regimen, med.unit)}`);
    return 0;
  },

  list(s, args) {
    const { values } = opts(args, { all: { type: "boolean" } });
    const meds = s.profile.medications.filter((m) => values.all || !m.archived);
    if (!meds.length) {
      s.ctx.out(values.all ? "no medications yet" : 'no current medications; add one with: dosely add NAME --schedule "daily 8am"');
      return 0;
    }
    const now = s.ctx.now();
    for (const line of table([["medication", "schedule", "supply"], ...meds.map((m) => {
      const sup = supply(s.profile, m, now);
      return [medLabel(m) + (m.archived ? " (stopped)" : ""), describe(m.regimen, m.unit),
              sup ? `${sup.count}${sup.daysLeft !== undefined ? ` (~${sup.daysLeft} d)` : ""}${sup.low ? " LOW" : ""}` : ""];
    })])) s.ctx.out(line);
    return 0;
  },

  show(s, args) {
    const { positionals } = opts(args, {});
    const med = findMedication(s.profile, positionals.join(" "), true);
    const now = s.ctx.now();
    const zone = s.profile.zone;
    s.ctx.out(`${medLabel(med)}${med.archived ? " (stopped)" : ""}`);
    const line = (label: string, value: string | undefined) => value && s.ctx.out(`  ${(label + ":").padEnd(14)}${value}`);
    line("schedule", describe(med.regimen, med.unit));
    line("since", med.regimen.start);
    line("for", med.purpose);
    line("instructions", med.instructions);
    line("prescriber", med.prescriber);
    line("pharmacy", med.pharmacy);
    if (med.limits?.maxPerDay) line("limit", `at most ${med.limits.maxPerDay} ${med.unit}(s) in 24 hours`);
    if (med.limits?.minHoursBetween) line("spacing", `at least ${med.limits.minHoursBetween} hours between doses`);
    const sup = supply(s.profile, med, now);
    if (sup) line("supply", supplyText(sup).replace(`${medLabel(med)}: `, ""));
    if (!med.archived) {
      const [next] = doses.nextDoses({ ...s.profile, medications: [med] }, now);
      if (next) line("next dose", `${formatInstant(next.occurrence.instant, zone)} (${amountText(next.occurrence.amount, med.unit)})`);
    }
    const last = s.profile.doses.filter((d) => d.med === med.id).sort((a, b) => b.at - a.at)[0];
    if (last) line("last", `${last.status} ${formatInstant(last.at, zone)}`);
    if (med.previous?.length) line("earlier", med.previous.map((r) => `${describe(r, med.unit)} (from ${r.start})`).join("; "));
    line("notes", med.notes);
    return 0;
  },

  today(s) {
    const now = s.ctx.now();
    const zone = s.profile.zone;
    const date = doses.today(s.profile, now);
    const [from, to] = doses.dayBounds(s.profile, date);
    const items = doses.agenda(s.profile, from!, to!, now);
    s.ctx.out(`${s.profile.name}, ${date} (${zone})`);
    if (!s.profile.medications.some((m) => !m.archived)) {
      s.ctx.out('no medications yet; add one with: dosely add NAME --schedule "daily 8am"');
      return 0;
    }
    if (!items.length) s.ctx.out("no scheduled doses today");
    for (const item of items) {
      const o = item.occurrence;
      let detail: string = item.status;
      if (item.record) detail = `${item.record.status} at ${localParts(item.record.at, zone).time}${item.record.note ? ` (${item.record.note})` : ""}`;
      s.ctx.out(`  ${STATUS_MARK[item.status]} ${o.time}  ${medLabel(item.med)}, ${amountText(o.amount, item.med.unit)}` +
                `${item.med.instructions ? `, ${item.med.instructions}` : ""}  ${detail}`);
    }
    const earlier = doses.needsAttention(s.profile, now).filter((i) => i.occurrence.date !== date);
    for (const i of earlier) s.ctx.out(`  missed yesterday: ${i.occurrence.time} ${medLabel(i.med)}`);
    for (const r of refillsNeeded(s.profile, now)) s.ctx.out(`  refill soon: ${supplyText(r)}`);
    for (const c of scheduleConflicts(s.profile, now)) {
      s.ctx.out(`  timing: ${medLabel(c.a)} at ${c.times[0]} and ${medLabel(c.b)} at ${c.times[1]} are ${c.hoursApart} h apart; ` +
                `your rule says ${c.rule.hours} h`);
    }
    return 0;
  },

  due(s) {
    const now = s.ctx.now();
    const items = doses.needsAttention(s.profile, now);
    if (!items.length) {
      const [next] = doses.nextDoses(s.profile, now);
      s.ctx.out(next ? `nothing due; next: ${medLabel(next.med)} at ${formatInstant(next.occurrence.instant, s.profile.zone)}` : "nothing due");
      return 0;
    }
    for (const i of items) {
      s.ctx.out(`${i.status === "due" ? "due" : "missed"}: ${medLabel(i.med)}, ${amountText(i.occurrence.amount, i.med.unit)} ` +
                `at ${formatInstant(i.occurrence.instant, s.profile.zone)}`);
    }
    return 1;
  },

  take(s, args) {
    return record(s, args, "taken");
  },

  skip(s, args) {
    return record(s, args, "skipped");
  },

  undo(s, args) {
    const { positionals } = opts(args, {});
    const med = findMedication(s.profile, positionals.join(" "), true);
    const removed = doses.undoLast(s.profile, med, s.ctx.now());
    s.dirty = true;
    s.ctx.out(`removed: ${medLabel(med)} ${removed.status} at ${formatInstant(removed.at, s.profile.zone)}`);
    return 0;
  },

  stop(s, args) {
    const { positionals } = opts(args, {});
    const med = findMedication(s.profile, positionals.join(" "));
    const today = doses.today(s.profile, s.ctx.now());
    med.archived = true;
    if (!med.regimen.end || med.regimen.end > today) med.regimen = { ...med.regimen, end: today };
    s.dirty = true;
    s.ctx.out(`stopped ${medLabel(med)}; its history is kept (restart it with: dosely restart ${med.name})`);
    return 0;
  },

  restart(s, args) {
    const { positionals } = opts(args, {});
    const name = positionals.join(" ");
    const med = s.profile.medications.filter((m) => m.archived).find((m) => m.name.toLowerCase() === name.toLowerCase())
      ?? findMedication(s.profile, name, true);
    if (!med.archived) throw new UsageError(`${medLabel(med)} hasn't been stopped`);
    if (s.profile.medications.some((m) => !m.archived && m.name.toLowerCase() === med.name.toLowerCase())) {
      throw new UsageError(`there's already a current ${med.name}`);
    }
    const today = doses.today(s.profile, s.ctx.now());
    const next: Regimen = { ...med.regimen, start: addDays(today, 0) };
    delete next.end;
    delete med.archived;
    doses.changeRegimen(med, next, today);
    s.dirty = true;
    s.ctx.out(`restarted ${medLabel(med)}: ${describe(med.regimen, med.unit)}`);
    return 0;
  },

  stock(s, args) {
    const { positionals } = opts(args, {});
    const now = s.ctx.now();
    if (!positionals.length) {
      const sups = s.profile.medications.filter((m) => !m.archived).map((m) => supply(s.profile, m, now)).filter((x) => x);
      if (!sups.length) s.ctx.out("no supply is tracked; set it with: dosely stock NAME COUNT");
      for (const sup of sups) s.ctx.out(`${sup!.low ? "LOW " : ""}${supplyText(sup!)}`);
      return 0;
    }
    const last = positionals.at(-1)!;
    const isCount = /^\+?\d+(\.\d+)?$/.test(last) && positionals.length > 1;
    const med = findMedication(s.profile, (isCount ? positionals.slice(0, -1) : positionals).join(" "));
    if (isCount) {
      if (last.startsWith("+")) addStock(med, Number(last.slice(1)), now);
      else setStock(med, Number(last), now);
      s.dirty = true;
    }
    const sup = supply(s.profile, med, now);
    s.ctx.out(sup ? supplyText(sup) : `${medLabel(med)}: supply isn't tracked; set it with: dosely stock ${med.name} COUNT`);
    return 0;
  },

  history(s, args) {
    const { values, positionals } = opts(args, { days: { type: "string" } });
    const days = number(values.days, "--days", { min: 1, integer: true }) ?? 14;
    const med = positionals.length ? findMedication(s.profile, positionals.join(" "), true) : undefined;
    const since = s.ctx.now() - days * 86_400_000;
    const records = s.profile.doses.filter((d) => d.at >= since && (!med || d.med === med.id)).sort((a, b) => a.at - b.at);
    if (!records.length) {
      s.ctx.out(`nothing recorded in the last ${days} days`);
      return 0;
    }
    for (const r of records) {
      const m = medicationById(s.profile, r.med);
      s.ctx.out(`${formatInstant(r.at, s.profile.zone)}  ${r.status.padEnd(7)}  ${m ? medLabel(m) : "?"}, ` +
                `${amountText(r.amount, m?.unit ?? "unit")}${r.note ? `  (${r.note})` : ""}`);
    }
    return 0;
  },

  measure(s, args) {
    const { values, positionals } = opts(args, { at: { type: "string" }, note: { type: "string" } });
    if (positionals.length < 2) throw new UsageError("usage: dosely measure KIND VALUE [UNIT], like: dosely measure bp 128/82");
    const [kind, value, ...unit] = positionals;
    const reading = health.parseReading(kind!, value!, unit.length ? unit.join(" ") : undefined);
    const now = s.ctx.now();
    const when = values.at ? parseWhen(values.at, s.profile.zone, now) : now;
    if (when > now + 300_000) throw new UsageError("a reading can't be in the future");
    const entry = health.addMeasurement(s.profile, reading, when, values.note);
    s.dirty = true;
    const outside = health.outsideTarget(s.profile, entry);
    s.ctx.out(`recorded ${health.KINDS[entry.kind]?.label ?? entry.kind} ${health.formatReading(entry)} at ` +
              `${formatInstant(when, s.profile.zone)}${outside.length ? `: outside your target (${outside.join(", ")})` : ""}`);
    return 0;
  },

  measures(s, args) {
    const { values, positionals } = opts(args, { days: { type: "string" } });
    const days = number(values.days, "--days", { min: 1, integer: true }) ?? 30;
    const now = s.ctx.now();
    const kind = positionals.length ? health.kindName(positionals[0]!) : undefined;
    const summaries = health.summarize(s.profile, now - days * 86_400_000, now + 1).filter((x) => !kind || x.kind === kind);
    if (!summaries.length) {
      s.ctx.out(`no readings in the last ${days} days`);
      return 0;
    }
    for (const x of summaries) {
      const target = s.profile.targets[x.kind];
      s.ctx.out(`${x.label} (${x.unit}), ${x.count} reading${x.count === 1 ? "" : "s"} in ${days} days` +
                (target ? `, target ${health.targetText(target)}, ${x.outside} outside` : ""));
      for (const v of x.values) {
        s.ctx.out(`  ${v.name === "value" ? "" : v.name + ": "}average ${v.average}, range ${v.min}-${v.max}` +
                  (v.change !== undefined ? `, change ${v.change > 0 ? "+" : ""}${v.change}` : ""));
      }
      s.ctx.out(`  latest ${health.formatReading(x.latest)} at ${formatInstant(x.latest.at, s.profile.zone)}`);
    }
    if (kind) {
      const recent = s.profile.measurements.filter((m) => m.kind === kind && m.at >= now - days * 86_400_000)
        .sort((a, b) => a.at - b.at).slice(-15);
      for (const m of recent) {
        const outside = health.outsideTarget(s.profile, m);
        s.ctx.out(`  ${formatInstant(m.at, s.profile.zone)}  ${health.formatReading(m)}${outside.length ? "  *" : ""}${m.note ? `  (${m.note})` : ""}`);
      }
    }
    return 0;
  },

  target(s, args) {
    const { positionals } = opts(args, {});
    if (positionals.length === 0) {
      const entries = Object.entries(s.profile.targets);
      if (!entries.length) s.ctx.out("no targets; set one with: dosely target bp 90-130/60-85");
      for (const [kind, t] of entries) s.ctx.out(`${health.KINDS[kind]?.label ?? kind}: ${health.targetText(t)}`);
      return 0;
    }
    const kind = health.kindName(positionals[0]!);
    if (positionals[1] === "none") {
      delete s.profile.targets[kind];
      s.ctx.out(`removed the ${kind} target`);
    } else {
      if (!positionals[1]) throw new UsageError("usage: dosely target KIND RANGE, like: dosely target bp 90-130/60-85");
      s.profile.targets[kind] = health.parseTarget(kind, positionals[1]);
      s.ctx.out(`${health.KINDS[kind]?.label ?? kind} target: ${health.targetText(s.profile.targets[kind]!)}`);
    }
    s.dirty = true;
    return 0;
  },

  symptom(s, args) {
    const { values, positionals } = opts(args, { at: { type: "string" }, note: { type: "string" } });
    const severity = positionals.at(-1);
    if (positionals.length < 2 || !/^\d+$/.test(severity!)) {
      throw new UsageError("usage: dosely symptom NAME SEVERITY (0-10), like: dosely symptom headache 4");
    }
    const now = s.ctx.now();
    const when = values.at ? parseWhen(values.at, s.profile.zone, now) : now;
    const entry = health.addSymptom(s.profile, positionals.slice(0, -1).join(" "), Number(severity), when, values.note);
    s.dirty = true;
    s.ctx.out(`recorded ${entry.name} (${entry.severity}/10) at ${formatInstant(when, s.profile.zone)}`);
    return 0;
  },

  symptoms(s, args) {
    const { values } = opts(args, { days: { type: "string" } });
    const days = number(values.days, "--days", { min: 1, integer: true }) ?? 30;
    const now = s.ctx.now();
    const list = health.summarizeSymptoms(s.profile, now - days * 86_400_000, now + 1);
    if (!list.length) s.ctx.out(`no symptoms noted in the last ${days} days`);
    for (const x of list) {
      s.ctx.out(`${x.name}: ${x.count} time${x.count === 1 ? "" : "s"}, average ${x.averageSeverity}/10, worst ${x.worst}, ` +
                `last ${formatInstant(x.last, s.profile.zone)}`);
    }
    return 0;
  },

  rule(s, args) {
    const { values, positionals } = opts(args, { note: { type: "string" } });
    if (positionals.length !== 3) throw new UsageError('usage: dosely rule A B HOURS [--note TEXT], like: dosely rule levothyroxine calcium 4');
    const a = findMedication(s.profile, positionals[0]!);
    const b = findMedication(s.profile, positionals[1]!);
    const hours = number(positionals[2], "HOURS", { min: 0.1 })!;
    const rule = addRule(s.profile, a, b, hours, values.note);
    s.dirty = true;
    s.ctx.out(`rule: keep ${medLabel(a)} and ${medLabel(b)} at least ${rule.hours} hours apart`);
    for (const c of scheduleConflicts(s.profile, s.ctx.now()).filter((c) => c.rule === rule)) {
      s.ctx.out(`  your schedule has them ${c.hoursApart} h apart (${c.times[0]} and ${c.times[1]}); ` +
                `consider moving one with: dosely edit NAME --schedule ...`);
    }
    return 0;
  },

  rules(s) {
    if (!s.profile.rules.length) s.ctx.out("no rules; add one with: dosely rule A B HOURS");
    for (const r of s.profile.rules) {
      const a = medicationById(s.profile, r.a);
      const b = medicationById(s.profile, r.b);
      s.ctx.out(`${a ? medLabel(a) : "?"} and ${b ? medLabel(b) : "?"}: at least ${r.hours} hours apart${r.note ? ` (${r.note})` : ""}`);
    }
    for (const c of scheduleConflicts(s.profile, s.ctx.now())) {
      s.ctx.out(`clash: ${medLabel(c.a)} at ${c.times[0]} and ${medLabel(c.b)} at ${c.times[1]} are only ${c.hoursApart} h apart`);
    }
    return 0;
  },

  adherence(s, args) {
    const { values } = opts(args, { days: { type: "string" } });
    const days = number(values.days, "--days", { min: 1, integer: true }) ?? 30;
    const now = s.ctx.now();
    const today = doses.today(s.profile, now);
    const scheduled = doses.activeMedications(s.profile).filter((m) => m.regimen.schedule.kind !== "as-needed");
    const r = adherence(s.profile, addDays(today, -(days - 1)), today, now, scheduled);
    if (!r.total.scheduled) {
      s.ctx.out(`no scheduled doses in the last ${days} days yet`);
      return 0;
    }
    s.ctx.out(`last ${days} days: ${r.total.percent}% of ${r.total.scheduled} doses taken, ${r.total.onTimePercent}% on time; ` +
              `streak ${r.streak} day${r.streak === 1 ? "" : "s"}`);
    for (const line of table([["medication", "taken", "on time", "late", "skipped", "missed"],
      ...r.meds.filter((m) => m.scheduled).map((m) => [medLabel(m.med), `${m.percent}%`, String(m.onTime), String(m.late),
                                                         String(m.skipped), String(m.missed)])])) s.ctx.out(`  ${line}`);
    const week = r.days.slice(-7).map((d) => (d.scheduled === 0 ? "·" : d.complete ? "✓" : d.onTime + d.late > 0 ? "~" : "✗"));
    s.ctx.out(`  last 7 days: ${week.join(" ")}   (✓ all taken, ~ some, ✗ none, · nothing due)`);
    return 0;
  },

  report(s, args) {
    const { values } = opts(args, { days: { type: "string" }, from: { type: "string" }, to: { type: "string" },
                                    html: { type: "string" }, out: { type: "string" }, force: { type: "boolean" } });
    const now = s.ctx.now();
    const today = doses.today(s.profile, now);
    const days = number(values.days, "--days", { min: 1, integer: true }) ?? 90;
    const to = values.to ? parseDate(values.to) : today;
    const from = values.from ? parseDate(values.from) : addDays(to, -(days - 1));
    if (from > to) throw new UsageError("--from is after --to");
    const built = report.build(s.profile, from, to, now);
    const target = values.html ?? values.out;
    if (!target) {
      for (const line of report.toMarkdown(built).split("\n")) s.ctx.out(line);
      return 0;
    }
    if (existsSync(target) && !values.force) throw new UsageError(`${target} already exists (add --force to replace it)`);
    writeFileSync(target, values.html ? report.toHtml(built) : report.toMarkdown(built), { mode: 0o600 });
    s.ctx.out(`wrote ${target}${values.html ? "; open it in a browser to read or print it" : ""}`);
    return 0;
  },

  export(s, args) {
    const { values, positionals } = opts(args, { force: { type: "boolean" } });
    const [what, file] = positionals;
    const makers: Record<string, (p: Profile) => string> = { doses: report.dosesCsv, measurements: report.measurementsCsv,
                                                              symptoms: report.symptomsCsv };
    if (!what || !makers[what] || !file) throw new UsageError("usage: dosely export doses|measurements|symptoms FILE.csv");
    if (existsSync(file) && !values.force) throw new UsageError(`${file} already exists (add --force to replace it)`);
    writeFileSync(file, makers[what]!(s.profile), { mode: 0o600 });
    s.ctx.out(`wrote ${file}`);
    return 0;
  },

  profile(s, args) {
    const { values, positionals } = opts(args, { zone: { type: "string" } });
    const [action, ...rest] = positionals;
    const name = rest.join(" ").trim();
    if (!action) {
      for (const p of s.data.profiles) {
        s.ctx.out(`${p.id === s.data.active ? "*" : " "} ${p.name} (${p.zone}), ${p.medications.filter((m) => !m.archived).length} medication(s)`);
      }
      return 0;
    }
    if (action === "add") {
      if (!name) throw new UsageError("usage: dosely profile add NAME [--zone ZONE]");
      if (s.data.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new UsageError(`there's already a profile called ${name}`);
      const p = newProfile(name, checkZone(values.zone ?? s.profile.zone));
      s.data.profiles.push(p);
      s.dirty = true;
      s.ctx.out(`added profile ${name} (${p.zone}); use it with --profile "${name}" or: dosely profile use ${name}`);
      return 0;
    }
    if (action === "use") {
      const p = findProfile(s.data, name);
      s.data.active = p.id;
      s.dirty = true;
      s.ctx.out(`now using ${p.name}`);
      return 0;
    }
    if (action === "zone") {
      const zone = checkZone(name);
      // Clock times stay the same in the new zone: 8am at home is 8am after the flight.
      s.profile.zone = zone;
      for (const m of s.profile.medications) if (!m.archived) m.regimen = { ...m.regimen, zone };
      s.dirty = true;
      s.ctx.out(`${s.profile.name} is now on ${zone} time; doses keep their clock times (8:00 stays 8:00 local).`);
      s.ctx.out("for every-N-hours medicines, check the next dose with: dosely today");
      return 0;
    }
    throw new UsageError("usage: dosely profile [add NAME | use NAME | zone ZONE]");
  },

  async watch(s, args) {
    const { values } = opts(args, { once: { type: "boolean" }, interval: { type: "string" } });
    const notify = s.ctx.notify ?? systemNotifier();
    const sleep = s.ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const interval = (number(values.interval, "--interval", { min: 10 }) ?? 60) * 1000;
    const announced = new Set<string>();
    if (!values.once) s.ctx.out(`watching ${s.profile.name}'s doses; leave this running (Ctrl+C to stop)`);
    for (;;) {
      let data: Data;
      try {
        data = store.load(s.path);                 // pick up doses recorded from other terminals
      } catch (err) {
        s.ctx.err(`dosely: ${(err as Error).message}`);
        data = s.data;
      }
      const profile = findProfile(data, data.profiles.some((p) => p.id === s.profile.id) ? s.profile.name : undefined);
      const now = s.ctx.now();
      for (const item of doses.needsAttention(profile, now, 1).filter((i) => i.status === "due")) {
        const key = `${item.med.id}|${item.occurrence.slot}`;
        if (announced.has(key)) continue;
        announced.add(key);
        const body = `${amountText(item.occurrence.amount, item.med.unit)}${item.med.instructions ? `, ${item.med.instructions}` : ""} ` +
                     `(due ${item.occurrence.time}). When taken: dosely take ${item.med.name}`;
        const title = `${profile.name}: time for ${medLabel(item.med)}`;
        const shown = notify(title, body);
        s.ctx.out(`\u0007${formatInstant(now, profile.zone)}  ${title}. ${body}${shown ? "" : " (no desktop notifications here)"}`);
      }
      if (values.once) return 0;
      await sleep(interval);
    }
  },
};

function record(s: Session, args: string[], status: "taken" | "skipped"): number {
  const { values, positionals } = opts(args, { at: { type: "string" }, amount: { type: "string" }, note: { type: "string" },
                                               force: { type: "boolean" } });
  const now = s.ctx.now();
  const zone = s.profile.zone;
  const at = values.at ? parseWhen(values.at, zone, now) : now;
  const query = positionals.join(" ");
  if (status === "taken" && query.toLowerCase() === "all") {
    const due = doses.needsAttention(s.profile, now, 3).filter((i) => i.status === "due");
    if (!due.length) {
      s.ctx.out("nothing is due right now");
      return 0;
    }
    for (const item of due) {
      const result = doses.logDose(s.profile, item.med, now, { at, slot: item.occurrence.slot, note: values.note, force: values.force });
      s.ctx.out(`taken: ${medLabel(item.med)}, ${amountText(result.record.amount, item.med.unit)} (the ${item.occurrence.time} dose)`);
      for (const w of result.warnings) s.ctx.out(`  note: ${w.message}`);
    }
    s.dirty = true;
    return 0;
  }
  const med = findMedication(s.profile, query);
  const result = doses.logDose(s.profile, med, now, {
    status, at, amount: number(values.amount, "--amount", { min: 0.01 }), note: values.note, force: values.force,
  });
  s.dirty = true;
  const which = result.occurrence ? ` (the ${result.occurrence.date === localParts(now, zone).date ? "" : result.occurrence.date + " "}` +
    `${result.occurrence.time} dose)` : med.regimen.schedule.kind === "as-needed" ? "" : " (an extra dose: none was scheduled near then)";
  s.ctx.out(`${status}: ${medLabel(med)}, ${amountText(result.record.amount, med.unit)} at ${formatInstant(at, zone)}${which}`);
  for (const w of result.warnings) s.ctx.out(`  ${w.blocking ? "WARNING" : "note"}: ${w.message}`);
  if (status === "taken" && med.stock) {
    const sup = supply(s.profile, med, now);
    if (sup?.low) s.ctx.out(`  refill soon: ${supplyText(sup)}`);
  }
  return 0;
}

// -- running ---------------------------------------------------------------------------------------------------

const ALIASES: Record<string, string> = { ls: "list", took: "take", log: "history", bp: "measure", meds: "list" };

export async function run(argv: string[], ctx: Context): Promise<number> {
  const args = [...argv];
  let file: string | undefined;
  let profileName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" || args[i] === "--profile") {
      const value = args[i + 1];
      if (value === undefined) {
        ctx.err(`dosely: ${args[i]} needs a value`);
        return 2;
      }
      if (args[i] === "--file") file = value; else profileName = value;
      args.splice(i, 2);
      i--;
    }
  }
  let command = args.shift() ?? "today";
  if (command === "bp") args.unshift("bp");
  command = ALIASES[command] ?? command;
  if (command === "--help" || command === "-h") command = "help";
  if (command === "--version" || command === "-v") command = "version";
  const path = file ?? store.defaultPath(ctx.env);
  try {
    if (command === "help") {
      for (const line of HELP.split("\n")) ctx.out(line);
      return 0;
    }
    if (command === "version") {
      ctx.out(`dosely ${VERSION}`);
      return 0;
    }
    if (command === "init") {
      const { values } = opts(args, { name: { type: "string" }, zone: { type: "string" }, force: { type: "boolean" } });
      const zone = checkZone(values.zone ?? systemZone());
      store.create(path, values.name?.trim() || "Me", zone, values.force);
      ctx.out(`created ${path}`);
      ctx.out(`profile "${values.name?.trim() || "Me"}", time zone ${zone}${values.zone ? "" : " (from this computer; change it with --zone)"}`);
      ctx.out('next: dosely add NAME --schedule "daily 8am" --strength "10 mg" --stock 30');
      return 0;
    }
    const handler = commands[command];
    if (!handler) {
      ctx.err(`dosely: unknown command "${command}"; see: dosely help`);
      return 2;
    }
    const data = store.load(path);
    const session: Session = { ctx, path, data, profile: findProfile(data, profileName), dirty: false };
    const code = await handler(session, args);
    if (session.dirty) store.save(path, session.data);
    return code;
  } catch (err: any) {
    if (err instanceof DataError || err instanceof UsageError || err instanceof ScheduleError || err instanceof TimeError ||
        err?.code?.startsWith?.("ERR_PARSE_ARGS")) {
      ctx.err(`dosely: ${err.message}`);
      return err instanceof UsageError || err?.code?.startsWith?.("ERR_PARSE_ARGS") ? 2 : 1;
    }
    throw err;
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  // "dosely report | head" closes the pipe early: stop quietly instead of crashing.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  const ctx: Context = {
    now: () => Date.now(),
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
    env: process.env,
  };
  run(process.argv.slice(2), ctx).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`dosely: unexpected error: ${err?.stack ?? err}\n`);
    process.exitCode = 3;
  });
}
