/**
 * What dosely keeps: people (profiles), their medications, every dose taken or
 * skipped, measurements (blood pressure, glucose, weight...), symptoms, and rules
 * the user's doctor or pharmacist gave about keeping medicines apart.
 *
 * Profiles let one person look after others too (a parent, a child), each with
 * their own time zone and records.
 */

import { randomBytes } from "node:crypto";
import type { Regimen } from "./schedule.js";

export const FORMAT = "dosely";
export const VERSION = 1;

export interface Stock {
  count: number;            // units on hand
  updated: number;          // instant of the last count
}

export interface AsNeededLimits {
  minHoursBetween?: number;
  maxPerDay?: number;       // units in any 24 hours
}

export interface Medication {
  id: string;
  name: string;
  strength?: string;        // "50 mg", free text as on the label
  unit: string;             // what one unit is: tablet, capsule, ml, puff, drop...
  instructions?: string;    // "with food", "on an empty stomach"
  purpose?: string;         // "blood pressure"
  prescriber?: string;
  pharmacy?: string;
  notes?: string;
  regimen: Regimen;
  previous?: Regimen[];     // earlier schedules, oldest first, so history is judged by the schedule then in force
  stock?: Stock;
  limits?: AsNeededLimits;
  archived?: boolean;       // stopped; kept for history and reports
  created: number;
}

export type DoseStatus = "taken" | "skipped";

export interface DoseRecord {
  id: string;
  med: string;              // medication id
  slot?: string;            // the scheduled dose this answers; absent for as-needed or extra doses
  due?: number;             // when that scheduled dose was due (instant)
  status: DoseStatus;
  at: number;               // when it was taken (or skipped)
  amount: number;
  note?: string;
}

export interface Measurement {
  id: string;
  kind: string;             // bp, glucose, weight, temperature, pulse, spo2, or anything else
  values: number[];         // [systolic, diastolic] for bp; one value otherwise
  unit: string;
  at: number;
  note?: string;
}

export interface SymptomEntry {
  id: string;
  name: string;
  severity: number;         // 0 (none) to 10 (worst)
  at: number;
  note?: string;
}

/** "Take A and B at least N hours apart", as the user's pharmacist or doctor said. */
export interface SeparationRule {
  id: string;
  a: string;                // medication id
  b: string;                // medication id
  hours: number;
  note?: string;
}

/** A target range the user's doctor gave, per value (bp has two: systolic and diastolic). */
export interface Target {
  min: (number | null)[];
  max: (number | null)[];
}

export interface Settings {
  graceMinutes: number;     // how late a dose can be before it counts as missed
  lowStockDays: number;     // warn when fewer days of supply than this are left
}

export interface Profile {
  id: string;
  name: string;
  zone: string;
  medications: Medication[];
  doses: DoseRecord[];
  measurements: Measurement[];
  symptoms: SymptomEntry[];
  rules: SeparationRule[];
  targets: Record<string, Target>;
  settings: Settings;
}

export interface Data {
  format: typeof FORMAT;
  version: typeof VERSION;
  active: string;           // the id of the profile commands use by default
  profiles: Profile[];
}

export class DataError extends Error {
  override name = "DataError";
}

export function newId(): string {
  return randomBytes(5).toString("hex");
}

export const DEFAULT_SETTINGS: Settings = { graceMinutes: 60, lowStockDays: 7 };

export function newProfile(name: string, zone: string): Profile {
  return { id: newId(), name, zone, medications: [], doses: [], measurements: [], symptoms: [], rules: [],
           targets: {}, settings: { ...DEFAULT_SETTINGS } };
}

export function emptyData(name: string, zone: string): Data {
  const profile = newProfile(name, zone);
  return { format: FORMAT, version: VERSION, active: profile.id, profiles: [profile] };
}

// -- finding things by what people type ------------------------------------------------------------

function pick<T extends { id: string }>(items: T[], query: string, label: (t: T) => string, what: string): T {
  const q = query.trim().toLowerCase();
  if (!q) throw new DataError(`which ${what}?`);
  const exact = items.filter((i) => label(i).toLowerCase() === q || i.id === q);
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length ? exact : items.filter((i) => label(i).toLowerCase().includes(q) || i.id.startsWith(q));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) {
    const names = items.map(label);
    throw new DataError(`no ${what} called "${query}"` + (names.length ? `; there are: ${names.join(", ")}` : ""));
  }
  throw new DataError(`"${query}" matches ${partial.map(label).join(", ")}; be more specific`);
}

export function findProfile(data: Data, query?: string): Profile {
  if (!query) {
    const active = data.profiles.find((p) => p.id === data.active);
    if (!active) throw new DataError("no active profile");
    return active;
  }
  return pick(data.profiles, query, (p) => p.name, "profile");
}

/** Current medications first; archived ones only match if nothing current does. */
export function findMedication(profile: Profile, query: string, includeArchived = false): Medication {
  const current = profile.medications.filter((m) => !m.archived);
  try {
    return pick(current, query, (m) => m.name, "medication");
  } catch (err) {
    if (!includeArchived) throw err;
    return pick(profile.medications, query, (m) => m.name, "medication");
  }
}

export function medicationById(profile: Profile, id: string): Medication | undefined {
  return profile.medications.find((m) => m.id === id);
}

/** "Lisinopril 10 mg". */
export function medLabel(med: Medication): string {
  return med.strength ? `${med.name} ${med.strength}` : med.name;
}
