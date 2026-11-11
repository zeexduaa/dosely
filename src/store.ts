/**
 * Reading and saving the data file.
 *
 * Everything lives in one JSON file on the user's own computer (by default in
 * the platform's data folder). Saving is atomic: the new contents go to a
 * temporary file that is flushed to disk and then renamed over the old one, so
 * a crash or power cut leaves either the old file or the new one. The previous
 * version is kept as ``<file>.bak``. On Unix the file is readable only by its
 * owner. Files from older versions of dosely are upgraded step by step when
 * read (see MIGRATIONS); files from newer versions are refused rather than
 * silently damaged.
 */

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
         unlinkSync, writeSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { type Data, DataError, FORMAT, VERSION, DEFAULT_SETTINGS, emptyData } from "./model.js";
import { checkZone } from "./time.js";

export function defaultPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.DOSELY_FILE) return env.DOSELY_FILE;
  const base = platform === "win32" ? env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "dosely", "dosely.json");
}

/** Upgrades from version N to N+1, applied in order. Version 1 is the first, so none yet. */
const MIGRATIONS: Record<number, (doc: any) => any> = {};

export function load(path: string): Data {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new DataError(`no data file at ${path}; start with: dosely init`);
    throw new DataError(`can't read ${path}: ${err?.message ?? err}`);
  }
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new DataError(`${path} isn't valid JSON (damaged?); the previous version is in ${path}.bak`);
  }
  return parse(doc, path);
}

export function parse(doc: any, path = "the data file"): Data {
  if (!doc || typeof doc !== "object" || doc.format !== FORMAT || !Number.isInteger(doc.version)) {
    throw new DataError(`${path} isn't a dosely data file`);
  }
  if (doc.version > VERSION) {
    throw new DataError(`${path} was written by a newer dosely (format ${doc.version}); please upgrade dosely`);
  }
  while (doc.version < VERSION) {
    const step = MIGRATIONS[doc.version];
    if (!step) throw new DataError(`can't upgrade ${path} from format ${doc.version}`);
    doc = step(doc);
    doc.version += 1;
  }
  check(doc, path);
  return doc as Data;
}

/** Checks the shape enough that the rest of the code can trust it; fills settings added later. */
function check(doc: any, path: string): void {
  const fail = (what: string) => { throw new DataError(`${path} is damaged: ${what}`); };
  if (!Array.isArray(doc.profiles) || doc.profiles.length === 0) fail("it has no profiles");
  for (const p of doc.profiles) {
    if (typeof p?.id !== "string" || typeof p?.name !== "string") fail("a profile has no id or name");
    try {
      checkZone(p.zone);
    } catch {
      fail(`profile ${p.name} has an unknown time zone "${p.zone}"`);
    }
    for (const key of ["medications", "doses", "measurements", "symptoms", "rules"]) {
      if (p[key] === undefined) p[key] = [];
      if (!Array.isArray(p[key])) fail(`profile ${p.name}'s ${key} isn't a list`);
    }
    p.settings = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
    if (!p.targets || typeof p.targets !== "object" || Array.isArray(p.targets)) p.targets = {};
    for (const m of p.medications) {
      if (typeof m?.id !== "string" || typeof m?.name !== "string" || !m.regimen?.schedule?.kind) {
        fail(`a medication in ${p.name} is incomplete`);
      }
    }
  }
  if (!doc.profiles.some((p: any) => p.id === doc.active)) doc.active = doc.profiles[0].id;
}

export function create(path: string, name: string, zone: string, overwrite = false): Data {
  if (existsSync(path) && !overwrite) throw new DataError(`there's already a data file at ${path}`);
  const data = emptyData(name, checkZone(zone));
  save(path, data);
  return data;
}

export function save(path: string, data: Data): void {
  const text = JSON.stringify(data, null, 1) + "\n";
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  closeSync(fd);
  try {
    if (existsSync(path)) {
      copyFileSync(path, `${path}.bak`);
      try { chmodSync(`${path}.bak`, 0o600); } catch { /* not supported here */ }
    }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  syncDir(dir);
}

function syncDir(dir: string): void {
  if (process.platform === "win32") return;      // directories can't be opened for fsync on Windows
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* some filesystems don't allow it; the rename is still atomic */ }
}
