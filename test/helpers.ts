import { newId, newProfile, type Medication, type Profile } from "../src/model.js";
import { parseSchedule, validate, type Regimen } from "../src/schedule.js";
import { toInstant } from "../src/time.js";

export const ZONE = "Europe/London";

/** A profile in London with the given medications. */
export function profileWith(...meds: Medication[]): Profile {
  const p = newProfile("Test", ZONE);
  p.medications.push(...meds);
  return p;
}

export function med(name: string, schedule: string, extra: Partial<Omit<Medication, "regimen">> & { regimen?: Partial<Regimen> } = {}): Medication {
  const { regimen, ...rest } = extra;
  return {
    id: newId(), name, unit: "tablet", created: 0,
    ...rest,
    regimen: validate({ schedule: parseSchedule(schedule), start: "2026-03-01", zone: ZONE, ...regimen }),
  };
}

/** An instant from a London wall-clock time: at("2026-03-02 08:00"). */
export function at(text: string): number {
  const [date, time] = text.split(" ");
  return toInstant(date!, time!, ZONE);
}
