/**
 * How much of each medicine is left, and when to refill.
 *
 * Stock goes down by the amount of each dose recorded as taken. Days of supply
 * come from the schedule (units per day); for as-needed medicines, from the
 * average use over the last 30 days.
 */

import { type Medication, type Profile, DataError, medLabel } from "./model.js";
import { unitsPerDay } from "./schedule.js";
import { addDays, localParts } from "./time.js";
import { round2 } from "./doses.js";

const DAY = 86_400_000;

export interface Supply {
  med: Medication;
  count: number;
  perDay: number;            // 0 when unknown (an as-needed medicine never used)
  daysLeft?: number;         // undefined when it can't be worked out
  runsOut?: string;          // local date
  low: boolean;
}

export function setStock(med: Medication, count: number, now: number): void {
  if (!(count >= 0) || count > 100_000) throw new DataError("the count must be between 0 and 100000");
  med.stock = { count: round2(count), updated: now };
}

export function addStock(med: Medication, count: number, now: number): void {
  if (!(count > 0)) throw new DataError("the number added must be more than 0");
  setStock(med, (med.stock?.count ?? 0) + count, now);
}

export function usePerDay(profile: Profile, med: Medication, now: number): number {
  const date = localParts(now, profile.zone).date;
  if (med.regimen.schedule.kind !== "as-needed") return unitsPerDay(med.regimen, date);
  const since = now - 30 * DAY;
  const used = profile.doses.filter((r) => r.med === med.id && r.status === "taken" && r.at > since)
    .reduce((sum, r) => sum + r.amount, 0);
  return used / 30;
}

export function supply(profile: Profile, med: Medication, now: number): Supply | undefined {
  if (!med.stock) return undefined;
  const perDay = usePerDay(profile, med, now);
  const result: Supply = { med, count: med.stock.count, perDay, low: false };
  if (perDay > 0) {
    const daysLeft = Math.floor(med.stock.count / perDay);
    result.daysLeft = daysLeft;
    result.runsOut = addDays(localParts(now, profile.zone).date, daysLeft);
    result.low = daysLeft < profile.settings.lowStockDays;
  } else if (med.stock.count === 0) {
    result.low = true;
    result.daysLeft = 0;
  }
  return result;
}

/** Medications with tracked stock that will run low soon, the soonest first. */
export function refillsNeeded(profile: Profile, now: number): Supply[] {
  return profile.medications.filter((m) => !m.archived)
    .map((m) => supply(profile, m, now))
    .filter((s): s is Supply => !!s && s.low)
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
}

export function supplyText(s: Supply): string {
  const unit = s.med.unit;
  if (s.daysLeft === undefined) return `${s.count} ${unit}(s) left`;
  if (s.daysLeft === 0) return `${medLabel(s.med)}: ${s.count === 0 ? "none left" : `${s.count} ${unit}(s) left, less than a day`}`;
  return `${medLabel(s.med)}: ${s.count} ${unit}(s) left, about ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} (runs out ${s.runsOut})`;
}
