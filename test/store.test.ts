import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../src/store.js";
import { DataError, findMedication, findProfile, newId, newProfile, type Medication } from "../src/model.js";

const dir = () => mkdtempSync(join(tmpdir(), "dosely-"));

function med(name: string, extra: Partial<Medication> = {}): Medication {
  return { id: newId(), name, unit: "tablet", created: 0,
           regimen: { schedule: { kind: "daily", doses: [{ time: "08:00", amount: 1 }] }, start: "2026-01-01", zone: "UTC" },
           ...extra };
}

test("create, save and load round-trip", () => {
  const path = join(dir(), "sub", "dosely.json");
  const data = store.create(path, "Me", "Europe/London");
  findProfile(data).medications.push(med("Lisinopril", { strength: "10 mg" }));
  store.save(path, data);
  const back = store.load(path);
  assert.equal(findProfile(back).name, "Me");
  assert.equal(findMedication(findProfile(back), "lisin").strength, "10 mg");
  assert.throws(() => store.create(path, "Me", "UTC"), /already a data file/);
});

test("saves keep a backup, leave no temp files, and are private on Unix", () => {
  const d = dir();
  const path = join(d, "dosely.json");
  const data = store.create(path, "Me", "UTC");
  const first = readFileSync(path, "utf8");
  findProfile(data).name = "Changed";
  store.save(path, data);
  assert.equal(readFileSync(`${path}.bak`, "utf8"), first);
  assert.deepEqual(readdirSync(d).sort(), ["dosely.json", "dosely.json.bak"]);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0);
});

test("clear errors for missing, damaged, foreign and newer files", () => {
  const d = dir();
  assert.throws(() => store.load(join(d, "none.json")), /start with: dosely init/);
  const path = join(d, "x.json");
  writeFileSync(path, "{ not json");
  assert.throws(() => store.load(path), /isn't valid JSON.*\.bak/);
  writeFileSync(path, JSON.stringify({ hello: 1 }));
  assert.throws(() => store.load(path), /isn't a dosely data file/);
  writeFileSync(path, JSON.stringify({ format: "dosely", version: 99, profiles: [] }));
  assert.throws(() => store.load(path), /newer dosely/);
  writeFileSync(path, JSON.stringify({ format: "dosely", version: 1, active: "a",
    profiles: [{ id: "a", name: "Me", zone: "Nowhere/Land" }] }));
  assert.throws(() => store.load(path), /unknown time zone/);
});

test("missing lists and settings are filled in", () => {
  const data = store.parse({ format: "dosely", version: 1, active: "gone", profiles: [{ id: "a", name: "Me", zone: "UTC" }] });
  const p = findProfile(data);
  assert.equal(p.id, "a");
  assert.deepEqual(p.doses, []);
  assert.equal(p.settings.graceMinutes, 60);
});

test("finding medications and profiles by name", () => {
  const p = newProfile("Me", "UTC");
  p.medications.push(med("Metformin"), med("Metoprolol"), med("Aspirin", { archived: true }));
  assert.equal(findMedication(p, "metf").name, "Metformin");
  assert.throws(() => findMedication(p, "met"), /matches Metformin, Metoprolol/);
  assert.throws(() => findMedication(p, "aspirin"), DataError);
  assert.equal(findMedication(p, "aspirin", true).name, "Aspirin");
  assert.throws(() => findMedication(p, "ibuprofen"), /there are: Metformin, Metoprolol/);
});

test("the default path follows each platform", () => {
  assert.equal(store.defaultPath({ DOSELY_FILE: "/x/y.json" }), "/x/y.json");
  assert.match(store.defaultPath({ XDG_DATA_HOME: "/data" }, "linux"), /data[\\/]dosely[\\/]dosely\.json$/);
  assert.match(store.defaultPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32"), /Roaming[\\/]dosely/);
});
