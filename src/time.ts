/**
 * Calendar dates, wall-clock times and time zones.
 *
 * Medicines are taken by the clock on the wall: "8:00 every morning" means 8:00
 * local time whether daylight saving time is on or off, and after flying to
 * another country. So schedules are stored as local dates and times plus an IANA
 * time zone ("Europe/London"), and only turned into exact instants when needed.
 *
 * Node's built-in Intl time-zone data does the zone math, so there are no
 * dependencies. Two awkward cases are handled the way most calendars do:
 *
 * - a time skipped when clocks go forward (02:30 on the spring change) moves
 *   forward by the size of the gap (03:30), so the dose isn't lost;
 * - a time that happens twice when clocks go back (01:30 in autumn) means the
 *   first one, so the dose isn't scheduled twice.
 */

/** A calendar date, "2026-03-29". */
export type LocalDate = string;
/** A wall-clock time, "08:00" (24-hour). */
export type LocalTime = string;

export class TimeError extends Error {
  override name = "TimeError";
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function parseDate(text: string): LocalDate {
  const m = DATE_RE.exec(text.trim());
  if (!m) throw new TimeError(`"${text}" isn't a date; use YYYY-MM-DD, like 2026-03-29`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new TimeError(`${text} isn't a real date`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** "8:00", "08:00", "20:30", also "8am", "8:30pm", "noon" and "midnight". */
export function parseTime(text: string): LocalTime {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "noon") return "12:00";
  if (t === "midnight") return "00:00";
  const ampm = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(t);
  if (ampm) {
    let h = Number(ampm[1]);
    const min = Number(ampm[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) throw new TimeError(`"${text}" isn't a time`);
    if (ampm[3] === "am" && h === 12) h = 0;
    if (ampm[3] === "pm" && h !== 12) h += 12;
    return `${pad(h)}:${pad(min)}`;
  }
  const m = TIME_RE.exec(t);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new TimeError(`"${text}" isn't a time; use 24-hour HH:MM (08:00, 20:30) or 8am / 8:30pm`);
  }
  return `${pad(Number(m[1]))}:${m[2]}`;
}

export function minutesOf(time: LocalTime): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

export function timeFromMinutes(minutes: number): LocalTime {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// -- dates ---------------------------------------------------------------------------------

function dateToDays(date: LocalDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) / DAY_MS;
}

function daysToDate(days: number): LocalDate {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return daysToDate(dateToDays(date) + days);
}

/** Whole days from ``a`` to ``b`` (negative if b is earlier). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return dateToDays(b) - dateToDays(a);
}

export function weekday(date: LocalDate): Weekday {
  return WEEKDAYS[new Date(dateToDays(date) * DAY_MS).getUTCDay()]!;
}

export function* dateRange(from: LocalDate, to: LocalDate): Generator<LocalDate> {
  for (let d = dateToDays(from); d <= dateToDays(to); d++) yield daysToDate(d);
}

// -- zones -----------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      throw new TimeError(`unknown time zone "${zone}"; use a name like Europe/London or America/New_York`);
    }
    formatters.set(zone, f);
  }
  return f;
}

export function checkZone(zone: string): string {
  formatter(zone);
  return zone;
}

/** The computer's own time zone. */
export function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export interface LocalParts {
  date: LocalDate;
  time: LocalTime;
  seconds: number;
}

/** What the wall clock shows in ``zone`` at an instant (ms since 1970). */
export function localParts(instant: number, zone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(instant))) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    seconds: Number(parts.second),
  };
}

/** The zone's offset from UTC at an instant, in minutes (London in summer: +60). */
export function offsetMinutes(instant: number, zone: string): number {
  const p = localParts(instant, zone);
  const asUtc = dateToDays(p.date) * DAY_MS + minutesOf(p.time) * MINUTE_MS + p.seconds * 1000;
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / MINUTE_MS);
}

/** The instant when the wall clock in ``zone`` shows ``date`` ``time`` (see the module notes on DST). */
export function toInstant(date: LocalDate, time: LocalTime, zone: string): number {
  const wall = dateToDays(date) * DAY_MS + minutesOf(time) * MINUTE_MS;
  // Offsets either side of the moment: if they differ, a clock change is near.
  const before = offsetMinutes(wall - DAY_MS, zone);
  const after = offsetMinutes(wall + DAY_MS, zone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset * MINUTE_MS)
    .filter((instant) => {
      const p = localParts(instant, zone);
      return p.date === date && p.time === time;
    })
    .sort((a, b) => a - b);
  if (candidates.length > 0) return candidates[0]!;          // the earlier of a repeated time
  // Skipped by a spring-forward change: move forward by the gap.
  return wall - before * MINUTE_MS;
}

export function formatInstant(instant: number, zone: string): string {
  const p = localParts(instant, zone);
  return `${p.date} ${p.time}`;
}
