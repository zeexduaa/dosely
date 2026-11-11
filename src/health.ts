/**
 * Measurements (blood pressure, glucose, weight...) and symptoms.
 *
 * Readings are checked for plausibility, not for health: "1200/80" is almost
 * certainly a typo, so it's refused, but dosely never says whether a real
 * reading is good or bad. Only the user's own targets (from their doctor) are
 * used to flag readings, and summaries report numbers, not judgements.
 */

import { type Measurement, type Profile, type SymptomEntry, type Target, DataError, newId } from "./model.js";

export interface Kind {
  label: string;
  units: string[];          // the first is the default
  values: string[];         // names of the values: ["systolic", "diastolic"] or ["value"]
  plausible: Record<string, [number, number][]>;   // per unit, per value: [low, high]
}

export const KINDS: Record<string, Kind> = {
  bp: { label: "blood pressure", units: ["mmHg"], values: ["systolic", "diastolic"],
        plausible: { mmHg: [[50, 300], [20, 200]] } },
  glucose: { label: "blood glucose", units: ["mg/dL", "mmol/L"], values: ["value"],
             plausible: { "mg/dL": [[10, 1000]], "mmol/L": [[0.5, 55]] } },
  weight: { label: "weight", units: ["kg", "lb"], values: ["value"], plausible: { kg: [[1, 500]], lb: [[2, 1100]] } },
  temperature: { label: "temperature", units: ["C", "F"], values: ["value"], plausible: { C: [[30, 45]], F: [[86, 113]] } },
  pulse: { label: "pulse", units: ["bpm"], values: ["value"], plausible: { bpm: [[20, 250]] } },
  spo2: { label: "oxygen saturation", units: ["%"], values: ["value"], plausible: { "%": [[50, 100]] } },
};

const ALIASES: Record<string, string> = {
  "blood-pressure": "bp", bloodpressure: "bp", pressure: "bp", sugar: "glucose", "blood-sugar": "glucose",
  temp: "temperature", hr: "pulse", "heart-rate": "pulse", heartrate: "pulse", oxygen: "spo2", o2: "spo2",
};

const UNIT_ALIASES: Record<string, string> = {
  "mg/dl": "mg/dL", "mmol/l": "mmol/L", mmol: "mmol/L", kgs: "kg", lbs: "lb", pounds: "lb",
  c: "C", "°c": "C", f: "F", "°f": "F", mmhg: "mmHg", bpm: "bpm", "%": "%",
};

export function kindName(text: string): string {
  const k = text.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(k)) throw new DataError(`"${text}" isn't a usable measurement name (letters, digits and -)`);
  return ALIASES[k] ?? k;
}

export interface Reading {
  kind: string;
  values: number[];
  unit: string;
}

/**
 * Reads what people type: "bp 128/82", "glucose 5.6 mmol/L", "weight 81.4kg",
 * "temperature 38.2C", "pulse 72", or a custom kind "peak-flow 420 L/min".
 */
export function parseReading(kindText: string, valueText: string, unitText?: string): Reading {
  const kind = kindName(kindText);
  const known = KINDS[kind];
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*([0-9]+(?:\.[0-9]+)?))?\s*([^\s0-9].*)?$/.exec(valueText);
  if (!m) throw new DataError(`"${valueText}" isn't a reading; type a number${kind === "bp" ? " like 128/82" : ""}`);
  const values = [Number(m[1])].concat(m[2] !== undefined ? [Number(m[2])] : []);
  let unit = (unitText ?? m[3] ?? "").trim();
  if (known) {
    unit = unit ? UNIT_ALIASES[unit.toLowerCase()] ?? unit : known.units[0]!;
    if (!known.units.includes(unit)) {
      throw new DataError(`${known.label} is measured in ${known.units.join(" or ")}, not "${unit}"`);
    }
    if (values.length !== known.values.length) {
      throw new DataError(kind === "bp" ? "blood pressure needs two numbers, like 128/82" : `${known.label} is one number`);
    }
    known.plausible[unit]!.forEach(([low, high], i) => {
      if (values[i]! < low || values[i]! > high) {
        throw new DataError(`${values[i]} ${unit} for ${known.values.length > 1 ? known.values[i] : known.label} looks like ` +
                            `a typo (expected ${low} to ${high})`);
      }
    });
    if (kind === "bp" && values[0]! <= values[1]!) {
      throw new DataError(`${values[0]}/${values[1]}: the first number (systolic) is normally the larger; check the order`);
    }
  } else if (!unit) {
    throw new DataError(`give a unit for "${kind}", like: dosely measure ${kind} 420 L/min`);
  }
  return { kind, values, unit };
}

export function addMeasurement(profile: Profile, reading: Reading, at: number, note?: string): Measurement {
  const entry: Measurement = { id: newId(), kind: reading.kind, values: reading.values, unit: reading.unit, at };
  if (note) entry.note = note;
  profile.measurements.push(entry);
  return entry;
}

export function addSymptom(profile: Profile, name: string, severity: number, at: number, note?: string): SymptomEntry {
  const clean = name.trim().toLowerCase();
  if (!clean || clean.length > 60) throw new DataError("give the symptom a short name, like headache or nausea");
  if (!Number.isInteger(severity) || severity < 0 || severity > 10) {
    throw new DataError("severity is a whole number from 0 (none) to 10 (worst imaginable)");
  }
  const entry: SymptomEntry = { id: newId(), name: clean, severity, at };
  if (note) entry.note = note;
  profile.symptoms.push(entry);
  return entry;
}

export function formatReading(m: { kind: string; values: number[]; unit: string }): string {
  return `${m.values.join("/")} ${m.unit}`;
}

// -- targets ---------------------------------------------------------------------------------------

/** "90-130/60-85" for bp, "4-7" for glucose, "-130/-85" (only a maximum), "60-" (only a minimum). */
export function parseTarget(kind: string, text: string): Target {
  const parts = text.split("/");
  const expected = KINDS[kind]?.values.length ?? 1;
  if (parts.length !== expected) {
    throw new DataError(`a ${KINDS[kind]?.label ?? kind} target has ${expected} part${expected > 1 ? "s, like 90-130/60-85" : ", like 4-7"}`);
  }
  const target: Target = { min: [], max: [] };
  for (const part of parts) {
    const m = /^\s*([0-9.]*)\s*-\s*([0-9.]*)\s*$/.exec(part);
    if (!m || (!m[1] && !m[2])) throw new DataError(`"${part}" isn't a range; use low-high, low- or -high`);
    const low = m[1] ? Number(m[1]) : null;
    const high = m[2] ? Number(m[2]) : null;
    if ((low !== null && Number.isNaN(low)) || (high !== null && Number.isNaN(high))) throw new DataError(`"${part}" isn't a range`);
    if (low !== null && high !== null && low > high) throw new DataError(`in "${part}" the low end is above the high end`);
    target.min.push(low);
    target.max.push(high);
  }
  return target;
}

export function targetText(target: Target): string {
  return target.min.map((low, i) => `${low ?? ""}-${target.max[i] ?? ""}`).join("/");
}

/** Which values of a reading are outside the user's target (empty if none, or no target). */
export function outsideTarget(profile: Profile, m: Measurement): string[] {
  const target = profile.targets[m.kind];
  if (!target) return [];
  const names = KINDS[m.kind]?.values ?? ["value"];
  const out: string[] = [];
  m.values.forEach((v, i) => {
    const low = target.min[i];
    const high = target.max[i];
    if (low != null && v < low) out.push(`${names.length > 1 ? names[i] + " " : ""}below ${low}`);
    if (high != null && v > high) out.push(`${names.length > 1 ? names[i] + " " : ""}above ${high}`);
  });
  return out;
}

// -- summaries -------------------------------------------------------------------------------------

export interface ValueStats {
  name: string;
  average: number;
  min: number;
  max: number;
  change?: number;          // average of the later half minus the earlier half
}

export interface MeasurementSummary {
  kind: string;
  label: string;
  unit: string;
  count: number;
  latest: Measurement;
  values: ValueStats[];
  outside: number;          // readings outside the target
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Per kind and unit, readings in ``[from, to)``. Readings in different units aren't mixed. */
export function summarize(profile: Profile, from: number, to: number): MeasurementSummary[] {
  const groups = new Map<string, Measurement[]>();
  for (const m of profile.measurements) {
    if (m.at < from || m.at >= to) continue;
    const key = `${m.kind}|${m.unit}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const summaries: MeasurementSummary[] = [];
  for (const readings of groups.values()) {
    readings.sort((a, b) => a.at - b.at);
    const first = readings[0]!;
    const names = KINDS[first.kind]?.values ?? ["value"];
    const values = names.map((name, i) => {
      const xs = readings.map((r) => r.values[i]!).filter((x) => x !== undefined);
      const stats: ValueStats = { name, average: round1(mean(xs)), min: Math.min(...xs), max: Math.max(...xs) };
      if (xs.length >= 4) {
        const half = Math.floor(xs.length / 2);
        stats.change = round1(mean(xs.slice(-half)) - mean(xs.slice(0, half)));
      }
      return stats;
    });
    summaries.push({ kind: first.kind, label: KINDS[first.kind]?.label ?? first.kind, unit: first.unit,
                     count: readings.length, latest: readings.at(-1)!, values,
                     outside: readings.filter((r) => outsideTarget(profile, r).length > 0).length });
  }
  return summaries.sort((a, b) => a.label.localeCompare(b.label));
}

export interface SymptomSummary {
  name: string;
  count: number;
  averageSeverity: number;
  worst: number;
  last: number;             // instant
}

export function summarizeSymptoms(profile: Profile, from: number, to: number): SymptomSummary[] {
  const groups = new Map<string, SymptomEntry[]>();
  for (const s of profile.symptoms) {
    if (s.at >= from && s.at < to) groups.set(s.name, [...(groups.get(s.name) ?? []), s]);
  }
  return [...groups].map(([name, entries]) => ({
    name, count: entries.length, averageSeverity: round1(mean(entries.map((e) => e.severity))),
    worst: Math.max(...entries.map((e) => e.severity)), last: Math.max(...entries.map((e) => e.at)),
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
