/**
 * Safety checks the user sets up. dosely is not a drug-interaction database and
 * gives no medical advice: every limit here is one the user entered, usually from
 * the label, their doctor or their pharmacist.
 *
 * - As-needed limits: at least N hours between doses, at most N units in any
 *   24 hours (as on a painkiller's label). Going over the daily maximum is
 *   *blocking*: it isn't recorded unless forced.
 * - Separation rules: "take A and B at least N hours apart" (for example, a
 *   thyroid tablet and calcium). Breaking one is a warning, and the schedule
 *   check points out regular dose times that are too close.
 */

import { type Medication, type Profile, type SeparationRule, DataError, medicationById, medLabel, newId } from "./model.js";
import { occurrences } from "./schedule.js";
import { formatInstant, localParts, toInstant, addDays } from "./time.js";

export interface Warning {
  kind: "max-per-day" | "too-soon" | "separation";
  message: string;
  blocking: boolean;
  okFrom?: number;           // when it would be fine
}

const HOUR = 3_600_000;

function takenOf(profile: Profile, medId: string) {
  return profile.doses.filter((r) => r.med === medId && r.status === "taken");
}

function hoursText(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  const rounded = Math.round(h * 10) / 10;
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

/** Warnings for taking ``amount`` of ``med`` at ``at``. */
export function checkDose(profile: Profile, med: Medication, at: number, amount: number): Warning[] {
  const warnings: Warning[] = [];
  const zone = profile.zone;
  const limits = med.limits;
  const mine = takenOf(profile, med.id);
  if (limits?.maxPerDay) {
    // Every 24-hour window that would contain the new dose: the one ending at it, and (for a
    // backdated dose) those ending at each later dose. Checking only the window before the new
    // dose let a backdated dose push the total over the limit unnoticed.
    const sumUpTo = (end: number) => mine.filter((r) => r.at > end - 24 * HOUR && r.at <= end)
      .reduce((sum, r) => sum + r.amount, 0) + amount;
    const before = sumUpTo(at);
    const later = mine.filter((r) => r.at > at && r.at < at + 24 * HOUR).map((r) => sumUpTo(r.at));
    const worst = Math.max(before, ...later);
    if (worst > limits.maxPerDay) {
      const message = `that would be ${worst} ${med.unit}(s) of ${medLabel(med)} in 24 hours; your limit is ${limits.maxPerDay}`;
      const warning: Warning = { kind: "max-per-day", blocking: true, message };
      if (before > limits.maxPerDay && worst === before) {
        // It becomes fine once enough of the earlier doses are more than 24 hours old.
        let excess = before - limits.maxPerDay;
        let okFrom = at;
        for (const r of mine.filter((r) => r.at > at - 24 * HOUR && r.at <= at).sort((a, b) => a.at - b.at)) {
          okFrom = r.at + 24 * HOUR;
          excess -= r.amount;
          if (excess <= 0) break;
        }
        warning.okFrom = okFrom;
        warning.message = `${message}. The next dose fits the limit from ${formatInstant(okFrom, zone)}`;
      } else {
        warning.message = `${message}, counting the doses recorded after that time`;
      }
      warnings.push(warning);
    }
  }
  if (limits?.minHoursBetween) {
    // The nearest other dose either side: a backdated dose can be too close to a later one.
    const nearest = [...mine].sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    if (nearest && Math.abs(at - nearest.at) < limits.minHoursBetween * HOUR) {
      const gap = hoursText(Math.abs(at - nearest.at) / HOUR);
      if (nearest.at <= at) {
        const okFrom = nearest.at + limits.minHoursBetween * HOUR;
        warnings.push({ kind: "too-soon", blocking: false, okFrom,
          message: `the last ${medLabel(med)} was ${gap} ago (at ${formatInstant(nearest.at, zone)}); ` +
                   `your limit is ${limits.minHoursBetween} hours between doses, so from ${formatInstant(okFrom, zone)}` });
      } else {
        warnings.push({ kind: "too-soon", blocking: false,
          message: `that's ${gap} before the ${medLabel(med)} recorded at ${formatInstant(nearest.at, zone)}; ` +
                   `your limit is ${limits.minHoursBetween} hours between doses` });
      }
    }
  }
  for (const rule of profile.rules) {
    const other = rule.a === med.id ? rule.b : rule.b === med.id ? rule.a : undefined;
    const otherMed = other ? medicationById(profile, other) : undefined;
    if (!other || !otherMed) continue;
    const close = takenOf(profile, other).filter((r) => Math.abs(r.at - at) < rule.hours * HOUR)
      .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    if (close) {
      const okFrom = close.at + rule.hours * HOUR;
      warnings.push({ kind: "separation", blocking: false, okFrom,
        message: `${medLabel(otherMed)} was taken at ${formatInstant(close.at, zone)}; your rule says keep it and ` +
                 `${medLabel(med)} ${rule.hours} hours apart` + (rule.note ? ` (${rule.note})` : "") });
    }
  }
  return warnings;
}

export function addRule(profile: Profile, a: Medication, b: Medication, hours: number, note?: string): SeparationRule {
  if (a.id === b.id) throw new DataError("a rule needs two different medications");
  if (!(hours > 0 && hours <= 48)) throw new DataError("the hours apart must be more than 0 and at most 48");
  const existing = profile.rules.find((r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id));
  if (existing) {
    existing.hours = hours;
    if (note !== undefined) existing.note = note;
    return existing;
  }
  const rule: SeparationRule = { id: newId(), a: a.id, b: b.id, hours };
  if (note) rule.note = note;
  profile.rules.push(rule);
  return rule;
}

export interface Conflict {
  rule: SeparationRule;
  a: Medication;
  b: Medication;
  times: [string, string];     // the two clock times that are too close
  hoursApart: number;
}

/** Regular dose times that break a separation rule (checked over the coming week). */
export function scheduleConflicts(profile: Profile, now: number): Conflict[] {
  const conflicts: Conflict[] = [];
  const from = toInstant(localParts(now, profile.zone).date, "00:00", profile.zone);
  const to = toInstant(addDays(localParts(now, profile.zone).date, 7), "00:00", profile.zone);
  for (const rule of profile.rules) {
    const a = medicationById(profile, rule.a);
    const b = medicationById(profile, rule.b);
    if (!a || !b || a.archived || b.archived) continue;
    const bs = occurrences(b.regimen, from, to);
    const seen = new Set<string>();
    for (const oa of occurrences(a.regimen, from, to)) {
      for (const ob of bs) {
        const gap = Math.abs(oa.instant - ob.instant) / HOUR;
        const key = `${oa.time}|${ob.time}`;
        if (gap < rule.hours && !seen.has(key)) {
          seen.add(key);
          conflicts.push({ rule, a, b, times: [oa.time, ob.time], hoursApart: Math.round(gap * 10) / 10 });
        }
      }
    }
  }
  return conflicts;
}
