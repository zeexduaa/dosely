/**
 * How well the schedule was kept.
 *
 * Over a date range, every scheduled dose whose grace period is over counts as:
 * on time (taken within the grace period), late (taken, but later), skipped, or
 * missed (nothing recorded). Adherence is the share taken at all; "on time" is
 * reported separately. Doses still upcoming or due are left out, so today isn't
 * held against you before it's over.
 */

import { type Medication, type Profile } from "./model.js";
import { agenda, activeMedications, dayBounds } from "./doses.js";
import { addDays, dateRange } from "./time.js";

export interface Counts {
  scheduled: number;
  onTime: number;
  late: number;
  skipped: number;
  missed: number;
}

export interface MedAdherence extends Counts {
  med: Medication;
  percent: number | undefined;       // taken / scheduled, undefined if nothing was due
  onTimePercent: number | undefined;
}

export interface DayAdherence extends Counts {
  date: string;
  complete: boolean;                 // every dose taken
}

export interface Report {
  from: string;
  to: string;
  total: Counts & { percent: number | undefined; onTimePercent: number | undefined };
  meds: MedAdherence[];
  days: DayAdherence[];
  streak: number;                    // days in a row, ending at ``to``, with every dose taken
}

function zero(): Counts {
  return { scheduled: 0, onTime: 0, late: 0, skipped: 0, missed: 0 };
}

function percent(part: number, whole: number): number | undefined {
  return whole ? Math.round((part / whole) * 1000) / 10 : undefined;
}

export function adherence(profile: Profile, from: string, to: string, now: number,
                          meds: Medication[] = activeMedications(profile)): Report {
  const grace = profile.settings.graceMinutes;
  const [start] = dayBounds(profile, from);
  const [, end] = dayBounds(profile, to);
  const byMed = new Map<string, Counts>(meds.map((m) => [m.id, zero()]));
  const byDay = new Map<string, Counts>([...dateRange(from, to)].map((d) => [d, zero()]));
  const total = zero();
  for (const item of agenda(profile, start!, end!, now, meds)) {
    if (item.status === "upcoming" || item.status === "due") continue;
    const kind: keyof Counts = item.status === "missed" ? "missed" : item.status === "skipped" ? "skipped"
      : (item.minutesLate ?? 0) <= grace ? "onTime" : "late";
    for (const counts of [total, byMed.get(item.med.id), byDay.get(item.occurrence.date)]) {
      if (!counts) continue;
      counts.scheduled++;
      counts[kind]++;
    }
  }
  const days = [...byDay].map(([date, c]) => ({ date, ...c, complete: c.scheduled > 0 && c.onTime + c.late === c.scheduled }));
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]!;
    if (d.scheduled === 0) continue;        // nothing (finished yet) that day: doesn't break a streak
    if (!d.complete) break;
    streak++;
  }
  return {
    from, to, days, streak,
    total: { ...total, percent: percent(total.onTime + total.late, total.scheduled), onTimePercent: percent(total.onTime, total.scheduled) },
    meds: meds.map((med) => {
      const c = byMed.get(med.id)!;
      return { med, ...c, percent: percent(c.onTime + c.late, c.scheduled), onTimePercent: percent(c.onTime, c.scheduled) };
    }),
  };
}

/** The last ``days`` days, ending today. */
export function recent(profile: Profile, now: number, days: number, today: string): Report {
  return adherence(profile, addDays(today, -(days - 1)), today, now);
}
