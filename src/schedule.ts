/**
 * When a medicine is taken.
 *
 * A *regimen* is a schedule plus the dates it runs and the time zone its clock
 * times belong to. Schedules come in these kinds:
 *
 *   daily           every day at the given times              "daily 8am, 8pm"
 *   weekdays        on some days of the week                  "mon,wed,fri 9:00"
 *   every-days      every N days from the start date          "every 3 days 8am"
 *   every-hours     every N hours of real time                "every 8 hours from 6am"
 *   cycle           N days on, M days off, repeating          "21 on 7 off 9pm"
 *   as-needed       no fixed times (limits are kept on the medication)   "as needed"
 *
 * Each clock time carries an amount ("8am x2" is two units at 8am). A *taper*
 * overrides the amount step by step: [{days: 5, amount: 4}, {days: 5, amount: 2}]
 * gives 4 units a dose for five days, then 2 for five days, then the regimen ends.
 *
 * "every-hours" counts real hours, not clock hours, because that's what an
 * "every 8 hours" antibiotic means: on the night clocks change, a dose is still
 * 8 hours after the last one.
 */

import {
  type LocalDate, type LocalTime, type Weekday, WEEKDAYS, TimeError, addDays, dateRange, daysBetween,
  localParts, minutesOf, parseTime, toInstant, weekday,
} from "./time.js";

export interface DoseTime {
  time: LocalTime;
  amount: number;
}

export interface TaperStep {
  days: number;
  amount: number;
}

export type Schedule =
  | { kind: "daily"; doses: DoseTime[] }
  | { kind: "weekdays"; days: Weekday[]; doses: DoseTime[] }
  | { kind: "every-days"; every: number; doses: DoseTime[] }
  | { kind: "every-hours"; every: number; first: LocalTime; amount: number }
  | { kind: "cycle"; on: number; off: number; doses: DoseTime[] }
  | { kind: "as-needed" };

export interface Regimen {
  schedule: Schedule;
  start: LocalDate;
  end?: LocalDate;          // last day, inclusive
  zone: string;
  taper?: TaperStep[];
}

/** One scheduled dose. ``slot`` names it uniquely within the medication, for logging. */
export interface Occurrence {
  slot: string;
  instant: number;
  date: LocalDate;
  time: LocalTime;
  amount: number;
}

export class ScheduleError extends Error {
  override name = "ScheduleError";
}

const HOUR_MS = 3_600_000;

// -- checking ---------------------------------------------------------------------------------------

export function validate(regimen: Regimen): Regimen {
  const s = regimen.schedule;
  const positive = (n: number, what: string, max: number) => {
    if (!Number.isInteger(n) || n < 1 || n > max) throw new ScheduleError(`${what} must be a whole number from 1 to ${max}`);
  };
  if ("doses" in s) {
    if (s.doses.length === 0) throw new ScheduleError("give at least one time of day");
    const seen = new Set<string>();
    for (const d of s.doses) {
      if (seen.has(d.time)) throw new ScheduleError(`${d.time} is listed twice`);
      seen.add(d.time);
      checkAmount(d.amount);
    }
    s.doses.sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
  }
  if (s.kind === "weekdays" && s.days.length === 0) throw new ScheduleError("give at least one day of the week");
  if (s.kind === "every-days") positive(s.every, "the number of days", 365);
  if (s.kind === "every-hours") {
    positive(s.every, "the number of hours", 168);
    checkAmount(s.amount);
  }
  if (s.kind === "cycle") {
    positive(s.on, "the days on", 365);
    positive(s.off, "the days off", 365);
  }
  if (regimen.end && daysBetween(regimen.start, regimen.end) < 0) {
    throw new ScheduleError(`the end date ${regimen.end} is before the start date ${regimen.start}`);
  }
  if (regimen.taper) {
    if (regimen.taper.length === 0) throw new ScheduleError("a taper needs at least one step");
    if (s.kind === "as-needed") throw new ScheduleError("an as-needed medicine can't have a taper");
    for (const step of regimen.taper) {
      positive(step.days, "each taper step's days", 365);
      checkAmount(step.amount);
    }
  }
  return regimen;
}

function checkAmount(amount: number): void {
  if (!(amount > 0) || amount > 1000 || Math.round(amount * 100) !== amount * 100) {
    throw new ScheduleError(`the amount ${amount} must be above 0, at most 1000, with at most two decimals`);
  }
}

/** The last day the regimen runs: its end date, or the end of its taper, whichever is first. */
export function lastDay(regimen: Regimen): LocalDate | undefined {
  const taperEnd = regimen.taper
    ? addDays(regimen.start, regimen.taper.reduce((sum, step) => sum + step.days, 0) - 1)
    : undefined;
  if (regimen.end && taperEnd) return daysBetween(regimen.end, taperEnd) < 0 ? taperEnd : regimen.end;
  return regimen.end ?? taperEnd;
}

function taperAmount(regimen: Regimen, date: LocalDate): number | undefined {
  if (!regimen.taper) return undefined;
  let day = daysBetween(regimen.start, date);
  for (const step of regimen.taper) {
    if (day < step.days) return step.amount;
    day -= step.days;
  }
  return undefined;
}

function activeOn(regimen: Regimen, date: LocalDate): boolean {
  const s = regimen.schedule;
  const since = daysBetween(regimen.start, date);
  const last = lastDay(regimen);
  if (since < 0 || (last && daysBetween(date, last) < 0)) return false;
  switch (s.kind) {
    case "daily": return true;
    case "weekdays": return s.days.includes(weekday(date));
    case "every-days": return since % s.every === 0;
    case "cycle": return since % (s.on + s.off) < s.on;
    default: return false;
  }
}

// -- occurrences ---------------------------------------------------------------------------------

/** Scheduled doses with ``from <= instant < to`` (ms since 1970), in time order. */
export function occurrences(regimen: Regimen, from: number, to: number): Occurrence[] {
  const s = regimen.schedule;
  const out: Occurrence[] = [];
  if (s.kind === "as-needed" || to <= from) return out;
  if (s.kind === "every-hours") {
    const step = s.every * HOUR_MS;
    const first = toInstant(regimen.start, s.first, regimen.zone);
    const last = lastDay(regimen);
    const stop = last ? Math.min(to, toInstant(addDays(last, 1), "00:00", regimen.zone)) : to;
    for (let k = Math.max(0, Math.ceil((from - first) / step)); first + k * step < stop; k++) {
      const instant = first + k * step;
      const p = localParts(instant, regimen.zone);
      out.push({ slot: `${regimen.start}#${k}`, instant, date: p.date, time: p.time,
                 amount: taperAmount(regimen, p.date) ?? s.amount });
    }
    return out;
  }
  // Clock-based kinds: walk the local dates around the window (a day either side covers any offset).
  const firstDate = addDays(localParts(from, regimen.zone).date, -1);
  const lastDate = addDays(localParts(to, regimen.zone).date, 1);
  for (const date of dateRange(firstDate, lastDate)) {
    if (!activeOn(regimen, date)) continue;
    const taper = taperAmount(regimen, date);
    for (const dose of s.doses) {
      const instant = toInstant(date, dose.time, regimen.zone);
      if (instant >= from && instant < to) {
        out.push({ slot: `${date}T${dose.time}`, instant, date, time: dose.time, amount: taper ?? dose.amount });
      }
    }
  }
  return out.sort((a, b) => a.instant - b.instant);
}

/** How many units the regimen uses on a typical day (for refill forecasts). */
export function unitsPerDay(regimen: Regimen, date: LocalDate): number {
  const s = regimen.schedule;
  if (s.kind === "as-needed") return 0;
  if (s.kind === "every-hours") return (24 / s.every) * (taperAmount(regimen, date) ?? s.amount);
  const perDose = (d: DoseTime) => taperAmount(regimen, date) ?? d.amount;
  const daily = s.doses.reduce((sum, d) => sum + perDose(d), 0);
  switch (s.kind) {
    case "daily": return daily;
    case "weekdays": return (daily * s.days.length) / 7;
    case "every-days": return daily / s.every;
    case "cycle": return (daily * s.on) / (s.on + s.off);
  }
}

// -- reading and describing ------------------------------------------------------------------------

/**
 * Parses the short forms shown in the module notes. Times are separated by commas
 * or "and"; "x2" after a time sets its amount.
 */
export function parseSchedule(text: string): Schedule {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(as needed|as-needed|prn|when needed)$/.test(t)) return { kind: "as-needed" };
  let m = /^every (\d+) hours? (?:from|starting|at) (.+?)(?: x(\d+(?:\.\d+)?))?$/.exec(t);
  if (m) return { kind: "every-hours", every: Number(m[1]), first: parseTime(m[2]!), amount: Number(m[3] ?? 1) };
  m = /^every (\d+) days? (.+)$/.exec(t);
  if (m) return { kind: "every-days", every: Number(m[1]), doses: parseDoses(m[2]!) };
  m = /^every other day (.+)$/.exec(t);
  if (m) return { kind: "every-days", every: 2, doses: parseDoses(m[1]!) };
  m = /^(\d+) (?:days? )?on,? (\d+) (?:days? )?off (.+)$/.exec(t);
  if (m) return { kind: "cycle", on: Number(m[1]), off: Number(m[2]), doses: parseDoses(m[3]!) };
  m = /^(?:daily|every day|each day) (.+)$/.exec(t);
  if (m) return { kind: "daily", doses: parseDoses(m[1]!) };
  m = /^((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s*,\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)*) (.+)$/.exec(t);
  if (m) {
    const days = m[1]!.split(",").map((d) => d.trim().slice(0, 3) as Weekday);
    if (days.some((d) => !WEEKDAYS.includes(d))) throw new ScheduleError(`unknown day in "${m[1]}"`);
    return { kind: "weekdays", days: [...new Set(days)], doses: parseDoses(m[2]!) };
  }
  m = /^weekdays (.+)$/.exec(t);
  if (m) return { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"], doses: parseDoses(m[1]!) };
  m = /^weekends? (.+)$/.exec(t);
  if (m) return { kind: "weekdays", days: ["sat", "sun"], doses: parseDoses(m[1]!) };
  try {
    return { kind: "daily", doses: parseDoses(t) };      // just times: "8am, 8pm"
  } catch {
    throw new ScheduleError(`can't read the schedule "${text}". Examples: "daily 8am, 8pm", "mon,wed,fri 9:00", ` +
      `"every 2 days 8am", "every 8 hours from 6am", "21 on 7 off 9pm", "as needed"`);
  }
}

function parseDoses(text: string): DoseTime[] {
  const doses = text.split(/\s*(?:,|\band\b)\s*/).filter(Boolean).map((piece) => {
    const m = /^(.+?)(?:\s*x\s*(\d+(?:\.\d+)?))?$/.exec(piece.trim());
    try {
      return { time: parseTime(m![1]!), amount: Number(m![2] ?? 1) };
    } catch (err) {
      if (err instanceof TimeError) throw new ScheduleError(err.message);
      throw err;
    }
  });
  if (doses.length === 0) throw new ScheduleError("give at least one time of day");
  return doses;
}

const COUNT_WORDS = ["", "once", "twice", "three times", "four times"];
const DAY_NAMES: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function listTimes(doses: DoseTime[], unit: string): string {
  const same = doses.every((d) => d.amount === doses[0]!.amount);
  const parts = doses.map((d) => (same ? d.time : `${d.time} (${amountText(d.amount, unit)})`));
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!;
  return same ? `${amountText(doses[0]!.amount, unit)} at ${joined}` : `at ${joined}`;
}

export function amountText(amount: number, unit: string): string {
  return `${amount} ${amount === 1 ? unit : plural(unit)}`;
}

function plural(unit: string): string {
  if (/(s|ml|mg|g|mcg|iu|units?)$/i.test(unit)) return unit;
  return unit.endsWith("y") ? unit.slice(0, -1) + "ies" : unit + "s";
}

/** "twice a day: 1 tablet at 08:00 and 20:00". */
export function describe(regimen: Regimen, unit = "dose"): string {
  const s = regimen.schedule;
  let text: string;
  switch (s.kind) {
    case "as-needed": text = "as needed"; break;
    case "every-hours": text = `every ${s.every} hours from ${s.first}: ${amountText(s.amount, unit)}`; break;
    default: {
      const times = COUNT_WORDS[s.doses.length] ?? `${s.doses.length} times`;
      const when = s.kind === "daily" ? `${times} a day`
        : s.kind === "weekdays" ? `${times} a day on ${s.days.map((d) => DAY_NAMES[d]).join(", ")}`
        : s.kind === "every-days" ? `every ${s.every === 2 ? "other day" : `${s.every} days`}, ${times} that day`
        : `${s.on} days on, ${s.off} off, ${times} a day`;
      text = `${when}: ${listTimes(s.doses, unit)}`;
    }
  }
  if (regimen.taper) {
    text += `; tapering ${regimen.taper.map((st) => `${st.amount} for ${st.days} day${st.days === 1 ? "" : "s"}`).join(", then ")}`;
  }
  const last = lastDay(regimen);
  if (last) text += `; until ${last}`;
  return text;
}
