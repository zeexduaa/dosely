/**
 * Today's doses, and recording what was taken.
 *
 * Every scheduled dose has a status:
 *
 *   upcoming   later than now
 *   due        its time has come, and it's within the grace period (default 60 minutes)
 *   missed     the grace period has passed with nothing recorded
 *   taken      recorded as taken (on time, or late: the record keeps when)
 *   skipped    recorded as deliberately not taken
 *
 * Doses scheduled before the medication was added to dosely are left out (unless
 * one was recorded), so adding a medicine at noon doesn't mark the morning missed.
 *
 * A dose record names the scheduled dose ("slot") it answers. Taking a dose without
 * saying which answers the open one that's due now; otherwise one coming up within
 * 2 hours (taken a little early); otherwise the latest one missed in the last 12 hours
 * (taken late). With none of those, or for an as-needed medicine, it's an extra dose.
 */

import { type DoseRecord, type DoseStatus, type Medication, type Profile, DataError, newId, medLabel } from "./model.js";
import { type Occurrence, type Regimen, occurrences } from "./schedule.js";
import { addDays, daysBetween, localParts, toInstant, formatInstant, type LocalDate } from "./time.js";
import { checkDose, type Warning } from "./safety.js";

export type SlotStatus = "upcoming" | "due" | "missed" | DoseStatus;

export interface AgendaItem {
  med: Medication;
  occurrence: Occurrence;
  status: SlotStatus;
  record?: DoseRecord;
  minutesLate?: number;      // for taken doses, how late (negative = early)
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MATCH_WINDOW = 12 * HOUR;
const EARLY_WINDOW = 2 * HOUR;

/** Every regimen the medication has had, oldest first. */
export function regimens(med: Medication): Regimen[] {
  return [...(med.previous ?? []), med.regimen];
}

/** Scheduled doses from all of the medication's regimens. */
export function medOccurrences(med: Medication, from: number, to: number): Occurrence[] {
  return regimens(med).flatMap((r) => occurrences(r, from, to)).sort((a, b) => a.instant - b.instant);
}

/**
 * Changes the schedule from ``date`` on. The old regimen is kept (ending the day before),
 * so earlier days are still judged by the schedule that applied then.
 */
export function changeRegimen(med: Medication, next: Regimen, date: LocalDate): void {
  const current = med.regimen;
  if (daysBetween(current.start, date) <= 0) {
    med.regimen = next;                          // it hasn't started yet: just replace it
    return;
  }
  const ended: Regimen = { ...current, end: addDays(date, -1) };
  if (current.end && daysBetween(current.end, ended.end!) > 0) ended.end = current.end;
  med.previous = [...(med.previous ?? []), ended];
  med.regimen = { ...next, start: date };
}

export function activeMedications(profile: Profile): Medication[] {
  return profile.medications.filter((m) => !m.archived);
}

/** The start and end (exclusive) of a local day in the profile's zone. */
export function dayBounds(profile: Profile, date: string): [number, number] {
  return [toInstant(date, "00:00", profile.zone), toInstant(addDays(date, 1), "00:00", profile.zone)];
}

export function today(profile: Profile, now: number): string {
  return localParts(now, profile.zone).date;
}

function recordsBySlot(profile: Profile): Map<string, DoseRecord> {
  const map = new Map<string, DoseRecord>();
  for (const r of profile.doses) if (r.slot) map.set(`${r.med}|${r.slot}`, r);
  return map;
}

export function statusOf(profile: Profile, occurrence: Occurrence, record: DoseRecord | undefined, now: number): SlotStatus {
  if (record) return record.status;
  if (occurrence.instant > now) return "upcoming";
  return now - occurrence.instant <= profile.settings.graceMinutes * MINUTE ? "due" : "missed";
}

/** Every scheduled dose with ``from <= time < to``, with its status, in time order. */
export function agenda(profile: Profile, from: number, to: number, now: number, meds = activeMedications(profile)): AgendaItem[] {
  const records = recordsBySlot(profile);
  const items: AgendaItem[] = [];
  for (const med of meds) {
    for (const occurrence of medOccurrences(med, from, to)) {
      const record = records.get(`${med.id}|${occurrence.slot}`);
      // Doses from before the medication was added can't have been tracked: leave them out
      // unless something was recorded for them (a backdated dose).
      if (!record && occurrence.instant < med.created) continue;
      const item: AgendaItem = { med, occurrence, status: statusOf(profile, occurrence, record, now) };
      if (record) {
        item.record = record;
        if (record.status === "taken") item.minutesLate = Math.round((record.at - occurrence.instant) / MINUTE);
      }
      items.push(item);
    }
  }
  return items.sort((a, b) => a.occurrence.instant - b.occurrence.instant || a.med.name.localeCompare(b.med.name));
}

/** What needs attention now: doses due, and doses missed in the last ``lookbackHours``. */
export function needsAttention(profile: Profile, now: number, lookbackHours = 24): AgendaItem[] {
  return agenda(profile, now - lookbackHours * HOUR, now + 1, now).filter((i) => i.status === "due" || i.status === "missed");
}

/** The next scheduled dose of each medication after ``now``. */
export function nextDoses(profile: Profile, now: number, days = 8): AgendaItem[] {
  const seen = new Set<string>();
  return agenda(profile, now + 1, now + days * 24 * HOUR, now).filter((i) => {
    if (seen.has(i.med.id) || i.record) return false;
    seen.add(i.med.id);
    return true;
  });
}

/**
 * Which scheduled dose a "take" without a slot answers. Being late is far more common than being
 * early, so the latest open dose that's already due wins; a dose that's still to come is chosen
 * only if it's soon (within EARLY_WINDOW) and nothing is currently due. Simply taking the nearest
 * one in time recorded a forgotten 8am dose taken at 2:30pm as the 8pm dose, leaving the
 * morning "missed" and the evening "taken", which could make someone skip their real evening dose.
 */
function pickOpenDose(profile: Profile, med: Medication, at: number, taken: Map<string, DoseRecord>): Occurrence | undefined {
  const open = medOccurrences(med, at - MATCH_WINDOW, at + MATCH_WINDOW).filter((o) => !taken.has(`${med.id}|${o.slot}`));
  const past = open.filter((o) => o.instant <= at).sort((a, b) => b.instant - a.instant);
  const soon = open.filter((o) => o.instant > at && o.instant - at <= EARLY_WINDOW).sort((a, b) => a.instant - b.instant);
  const dueNow = past.find((o) => at - o.instant <= profile.settings.graceMinutes * MINUTE);
  return dueNow ?? soon[0] ?? past[0];
}

export interface LogOptions {
  status?: DoseStatus;
  at?: number;               // default: now
  amount?: number;           // default: the scheduled amount, or 1 for as-needed
  slot?: string;             // a specific scheduled dose
  note?: string;
  force?: boolean;           // record even if it breaks an as-needed limit
}

export interface LogResult {
  record: DoseRecord;
  occurrence?: Occurrence;
  warnings: Warning[];
}

/** Records a dose taken or skipped. Taking reduces the stock (if it's tracked). */
export function logDose(profile: Profile, med: Medication, now: number, options: LogOptions = {}): LogResult {
  const status = options.status ?? "taken";
  const at = options.at ?? now;
  if (at > now + 5 * MINUTE) throw new DataError("a dose can't be recorded in the future");
  const taken = recordsBySlot(profile);
  let occurrence: Occurrence | undefined;
  if (options.slot) {
    occurrence = medOccurrences(med, at - 8 * 24 * HOUR, at + 8 * 24 * HOUR).find((o) => o.slot === options.slot);
    if (!occurrence) throw new DataError(`${medLabel(med)} has no scheduled dose ${options.slot}`);
  } else if (med.regimen.schedule.kind !== "as-needed") {
    occurrence = pickOpenDose(profile, med, at, taken);
  }
  if (occurrence) {
    const existing = taken.get(`${med.id}|${occurrence.slot}`);
    if (existing) {
      throw new DataError(`the ${occurrence.time} dose of ${medLabel(med)} on ${occurrence.date} is already recorded as ` +
        `${existing.status} (at ${formatInstant(existing.at, profile.zone)}); use "undo" to change it`);
    }
  }
  if (status === "skipped" && !occurrence) {
    throw new DataError(`there's no scheduled dose of ${medLabel(med)} near then to skip`);
  }
  const amount = options.amount ?? occurrence?.amount ?? 1;
  if (!(amount > 0)) throw new DataError("the amount must be more than 0");

  const warnings = status === "taken" ? checkDose(profile, med, at, amount) : [];
  const blocking = warnings.filter((w) => w.blocking);
  if (blocking.length && !options.force) {
    throw new DataError(blocking.map((w) => w.message).join("; ") +
      ". If your doctor told you otherwise, record it with --force");
  }
  const record: DoseRecord = { id: newId(), med: med.id, status, at, amount };
  if (occurrence) record.slot = occurrence.slot;
  if (options.note) record.note = options.note;
  profile.doses.push(record);
  if (status === "taken" && med.stock) {
    med.stock = { count: Math.max(0, round2(med.stock.count - amount)), updated: now };
  }
  const result: LogResult = { record, warnings };
  if (occurrence) result.occurrence = occurrence;
  return result;
}

/** Removes the most recent record of a medication (putting taken units back in stock). */
export function undoLast(profile: Profile, med: Medication, now: number): DoseRecord {
  let index = -1;
  for (let i = 0; i < profile.doses.length; i++) {
    const r = profile.doses[i]!;
    if (r.med === med.id && (index < 0 || r.at >= profile.doses[index]!.at)) index = i;
  }
  if (index < 0) throw new DataError(`nothing is recorded for ${medLabel(med)}`);
  const [record] = profile.doses.splice(index, 1);
  if (record!.status === "taken" && med.stock) med.stock = { count: round2(med.stock.count + record!.amount), updated: now };
  return record!;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
