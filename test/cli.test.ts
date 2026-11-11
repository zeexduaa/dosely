import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, parseWhen, parseTaper, type Context } from "../src/cli.js";
import { toInstant } from "../src/time.js";

const ZONE = "Europe/London";

/** A test terminal: a fixed clock that can be moved, and captured output. */
function terminal(start = "2026-03-02 07:30") {
  const dir = mkdtempSync(join(tmpdir(), "dosely-cli-"));
  const file = join(dir, "dosely.json");
  let now = clock(start);
  const out: string[] = [];
  const err: string[] = [];
  const notes: string[] = [];
  const ctx: Context = {
    now: () => now, out: (l) => out.push(l), err: (l) => err.push(l), env: { DOSELY_FILE: file },
    notify: (title, body) => { notes.push(`${title} | ${body}`); return true; },
  };
  return {
    file, dir, out, err, notes,
    at(time: string) { now = clock(time); },
    async run(...argv: string[]) {
      out.length = 0;
      err.length = 0;
      return run(argv, ctx);
    },
    text() { return out.join("\n"); },
  };
}

function clock(text: string): number {
  const [date, time] = text.split(" ");
  return toInstant(date!, time!, ZONE);
}

async function setUp() {
  const t = terminal("2026-03-01 00:00");      // medications added before their first dose
  assert.equal(await t.run("init", "--name", "Ada", "--zone", ZONE), 0);
  assert.equal(await t.run("add", "Lisinopril", "--schedule", "daily 8am", "--strength", "10 mg", "--for", "blood pressure",
                           "--stock", "20", "--start", "2026-03-01"), 0);
  assert.equal(await t.run("add", "Metformin", "--schedule", "8am, 8pm", "--instructions", "with food", "--start", "2026-03-01"), 0);
  assert.equal(await t.run("add", "Paracetamol", "--schedule", "as needed", "--strength", "500 mg", "--max-per-day", "8",
                           "--min-hours", "4", "--stock", "16"), 0);
  return t;
}

test("init, add and today", async () => {
  const t = await setUp();
  t.at("2026-03-02 07:30");
  assert.match(t.err.join(), /^$/);
  await t.run("today");
  const text = t.text();
  assert.match(text, /^Ada, 2026-03-02 \(Europe\/London\)/);
  assert.match(text, /\[ \] 08:00  Lisinopril 10 mg, 1 tablet  upcoming/);
  assert.match(text, /\[ \] 08:00  Metformin, 1 tablet, with food  upcoming/);
  assert.match(text, /\[ \] 20:00  Metformin/);
  assert.match(text, /missed yesterday: 08:00 Metformin|missed yesterday: 20:00 Metformin/);
  assert.doesNotMatch(text, /Paracetamol/);                    // as-needed: not on the schedule
  assert.equal(await t.run("add", "lisinopril", "--schedule", "daily 9am"), 2);
  assert.match(t.err[0]!, /already on the list/);
  assert.equal(await t.run("add", "X", "--schedule", "whenever"), 1);
  assert.match(t.err[0]!, /can't read the schedule/);
});

test("taking, skipping, undo and what's due", async () => {
  const t = await setUp();
  t.at("2026-03-02 08:10");
  assert.equal(await t.run("due"), 1);
  assert.match(t.text(), /due: Lisinopril 10 mg, 1 tablet at 2026-03-02 08:00/);
  assert.match(t.text(), /missed: Metformin, 1 tablet at 2026-03-01 20:00/);
  await t.run("take", "lisinopril");
  assert.match(t.text(), /taken: Lisinopril 10 mg, 1 tablet at 2026-03-02 08:10 \(the 08:00 dose\)/);
  await t.run("skip", "metformin", "--note", "no breakfast");
  assert.match(t.text(), /skipped: Metformin/);
  await t.run("today");
  assert.match(t.text(), /\[x\] 08:00  Lisinopril 10 mg, 1 tablet  taken at 08:10/);
  assert.match(t.text(), /\[-\] 08:00  Metformin, 1 tablet, with food  skipped at 08:10 \(no breakfast\)/);
  await t.run("stock", "lisinopril");
  assert.match(t.text(), /19 tablet\(s\) left/);
  await t.run("undo", "lisinopril");
  await t.run("stock", "lisinopril");
  assert.match(t.text(), /20 tablet\(s\) left/);
  t.at("2026-03-02 20:05");
  await t.run("take", "all");
  assert.match(t.text(), /taken: Metformin, 1 tablet \(the 20:00 dose\)/);
  await t.run("take", "metformin", "--at", "yesterday 20:00");
  assert.match(t.text(), /the 2026-03-01 20:00 dose/);
});

test("as-needed limits block, and --force overrides", async () => {
  const t = await setUp();
  t.at("2026-03-02 09:00");
  for (const time of ["2026-03-02 06:00", "2026-03-02 10:00", "2026-03-02 14:00"]) {
    t.at(time);
    assert.equal(await t.run("take", "paracetamol", "--amount", "2"), 0);
  }
  t.at("2026-03-02 16:00");
  await t.run("take", "paracetamol", "--amount", "2");
  assert.match(t.text(), /note: the last Paracetamol 500 mg was 2 hours ago/);
  t.at("2026-03-02 21:00");
  assert.equal(await t.run("take", "paracetamol", "--amount", "2"), 1);
  assert.match(t.err[0]!, /10 tablet\(s\) of Paracetamol 500 mg in 24 hours; your limit is 8/);
  assert.equal(await t.run("take", "paracetamol", "--amount", "2", "--force"), 0);
  assert.match(t.text(), /WARNING/);
});

test("measurements, targets, symptoms and rules", async () => {
  const t = await setUp();
  t.at("2026-03-02 07:30");
  await t.run("target", "bp", "90-130/60-85");
  await t.run("measure", "bp", "142/91", "--note", "after stairs");
  assert.match(t.text(), /blood pressure 142\/91 mmHg .*outside your target \(systolic above 130, diastolic above 85\)/);
  await t.run("bp", "124/80");
  assert.match(t.text(), /recorded blood pressure 124\/80 mmHg/);
  assert.equal(await t.run("measure", "bp", "1240/80"), 1);
  assert.match(t.err[0]!, /looks like a typo/);
  await t.run("measures", "bp");
  assert.match(t.text(), /blood pressure \(mmHg\), 2 readings in 30 days, target 90-130\/60-85, 1 outside/);
  assert.match(t.text(), /systolic: average 133, range 124-142/);
  await t.run("symptom", "headache", "5", "--note", "morning");
  assert.match(t.text(), /recorded headache \(5\/10\)/);
  assert.equal(await t.run("symptom", "headache"), 2);
  await t.run("add", "Calcium", "--schedule", "daily 9am", "--start", "2026-03-01");
  await t.run("rule", "lisinopril", "calcium", "2", "--note", "pharmacist");
  assert.match(t.text(), /keep Lisinopril 10 mg and Calcium at least 2 hours apart/);
  assert.match(t.text(), /your schedule has them 1 h apart \(08:00 and 09:00\)/);
  await t.run("rules");
  assert.match(t.text(), /clash: Lisinopril 10 mg at 08:00 and Calcium at 09:00/);
});

test("editing a schedule keeps history; stop and restart", async () => {
  const t = await setUp();
  t.at("2026-03-02 08:05");
  await t.run("take", "lisinopril");
  t.at("2026-03-03 07:00");
  await t.run("edit", "lisinopril", "--schedule", "daily 9pm");
  assert.match(t.text(), /updated Lisinopril 10 mg: once a day: 1 tablet at 21:00/);
  await t.run("show", "lisinopril");
  assert.match(t.text(), /earlier:\s+once a day: 1 tablet at 08:00; until 2026-03-02 \(from 2026-03-01\)/);
  await t.run("adherence", "--days", "3");
  assert.match(t.text(), /Lisinopril 10 mg\s+50%/);                  // 03-01 missed, 03-02 taken; 03-03 not due yet
  await t.run("stop", "metformin");
  await t.run("list");
  assert.doesNotMatch(t.text(), /Metformin/);
  await t.run("list", "--all");
  assert.match(t.text(), /Metformin \(stopped\)/);
  await t.run("restart", "metformin");
  assert.match(t.text(), /restarted Metformin/);
});

test("reports and exports", async () => {
  const t = await setUp();
  t.at("2026-03-02 08:05");
  await t.run("take", "lisinopril");
  await t.run("measure", "weight", "81.2", "kg");
  await t.run("report", "--days", "7");
  assert.match(t.text(), /^# Health summary: Ada/);
  assert.match(t.text(), /\| Lisinopril 10 mg \| once a day: 1 tablet at 08:00 \| blood pressure/);
  const html = join(t.dir, "summary.html");
  await t.run("report", "--html", html);
  assert.match(readFileSync(html, "utf8"), /<title>Health summary: Ada<\/title>/);
  assert.equal(await t.run("report", "--html", html), 2);              // won't overwrite
  const csv = join(t.dir, "doses.csv");
  await t.run("export", "doses", csv);
  assert.match(readFileSync(csv, "utf8"), /2026-03-02,08:05,Lisinopril 10 mg,taken,1,tablet,2026-03-02 08:00,/);
  assert.equal(await t.run("export", "nonsense", csv), 2);
});

test("profiles for looking after someone else", async () => {
  const t = await setUp();
  t.at("2026-03-02 07:30");
  await t.run("profile", "add", "Mum", "--zone", "Asia/Karachi");
  await t.run("--profile", "Mum", "add", "Amlodipine", "--schedule", "daily 9pm");
  await t.run("--profile", "mum", "today");
  assert.match(t.text(), /^Mum, 2026-03-02 \(Asia\/Karachi\)/);
  assert.match(t.text(), /21:00  Amlodipine/);
  await t.run("today");
  assert.doesNotMatch(t.text(), /Amlodipine/);
  await t.run("profile");
  assert.match(t.text(), /\* Ada \(Europe\/London\), 3 medication/);
  await t.run("profile", "zone", "America/New_York");
  await t.run("today");
  assert.match(t.text(), /America\/New_York/);
});

test("watch sends one reminder per due dose", async () => {
  const t = await setUp();
  t.at("2026-03-02 08:01");
  assert.equal(await t.run("watch", "--once"), 0);
  assert.equal(t.notes.length, 2);
  assert.match(t.notes.join("\n"), /Ada: time for Lisinopril 10 mg \| 1 tablet \(due 08:00\)\. When taken: dosely take Lisinopril/);
  assert.match(t.notes.join("\n"), /Metformin \| 1 tablet, with food/);
});

test("errors: no data file, unknown commands and options", async () => {
  const t = terminal();
  assert.equal(await t.run("today"), 1);
  assert.match(t.err[0]!, /start with: dosely init/);
  assert.equal(await t.run("init", "--zone", "Mars/Base"), 1);
  assert.match(t.err[0]!, /unknown time zone/);
  assert.equal(await t.run("init", "--zone", ZONE), 0);
  assert.equal(await t.run("fly"), 2);
  assert.equal(await t.run("list", "--colour"), 2);
  assert.match(t.err[0]!, /Unknown option/);
  assert.equal(await t.run("help"), 0);
  assert.match(t.text(), /dosely take NAME/);
  assert.ok(existsSync(t.file));
});

test("times and tapers as typed", () => {
  const now = clock("2026-03-02 12:00");
  assert.equal(parseWhen("8:15", ZONE, now), clock("2026-03-02 08:15"));
  assert.equal(parseWhen("yesterday 8pm", ZONE, now), clock("2026-03-01 20:00"));
  assert.equal(parseWhen("2026-02-28 07:00", ZONE, now), clock("2026-02-28 07:00"));
  assert.equal(parseWhen("90 min ago", ZONE, now), now - 90 * 60_000);
  // A bare time later than now is the last time it was that time: last night, just after midnight.
  assert.equal(parseWhen("23:45", ZONE, clock("2026-03-03 00:30")), clock("2026-03-02 23:45"));
  assert.equal(parseWhen("today 23:45", ZONE, clock("2026-03-03 00:30")), clock("2026-03-03 23:45"));
  assert.equal(parseWhen("2h ago", ZONE, now), now - 2 * 3_600_000);
  assert.deepEqual(parseTaper("4x5, 2x5,1x3"), [{ amount: 4, days: 5 }, { amount: 2, days: 5 }, { amount: 1, days: 3 }]);
  assert.throws(() => parseTaper("4 for 5"), /AMOUNTxDAYS/);
});


test("a medication added today doesn't count this morning's doses as missed", async () => {
  const t = terminal("2026-03-02 12:30");
  await t.run("init", "--zone", ZONE);
  await t.run("add", "Amoxicillin", "--schedule", "every 8 hours from 6am");
  await t.run("today");
  assert.doesNotMatch(t.text(), /06:00/);
  assert.match(t.text(), /\[ \] 14:00  Amoxicillin, 1 tablet  upcoming/);
  await t.run("take", "amoxicillin", "--at", "6:10");        // but a backdated dose still counts
  await t.run("today");
  assert.match(t.text(), /\[x\] 06:00  Amoxicillin, 1 tablet  taken at 06:10/);
});
