# dosely

**A private medication and health tracker for the command line.** It tells you what to take
and when, reminds you, keeps track of what you took, warns before you run out, and turns it
all into a one-page summary for your next doctor's appointment. Everything stays in one file
on your own computer. There's no account, no cloud and no tracking.

```console
$ dosely
Ada, 2026-03-02 (Europe/London)
  [x] 08:00  Lisinopril 10 mg, 1 tablet  taken at 08:10
  [-] 08:00  Metformin, 1 tablet, with food  skipped at 08:10 (no breakfast)
  [ ] 20:00  Metformin, 1 tablet, with food  upcoming
  refill soon: Lisinopril 10 mg: 5 tablet(s) left, about 5 days (runs out 2026-03-07)

$ dosely take metformin
taken: Metformin, 1 tablet at 2026-03-02 20:05 (the 20:00 dose)

$ dosely bp 142/91
recorded blood pressure 142/91 mmHg at 2026-03-02 20:06: outside your target (systolic above 130, diastolic above 85)

$ dosely report --html summary.html
wrote summary.html; open it in a browser to read or print it
```

## What it does

- **Schedules that match real prescriptions.**
  - Daily times (`8am, 8pm`), different amounts per time (`8am x2`).
  - Days of the week (`mon,wed,fri 9:00`, `weekdays 7am`).
  - Every N days (`every other day 8am`), every N hours (`every 8 hours from 6am`).
  - On/off cycles (`21 on 7 off 9pm`), tapering doses (`--taper 4x5,2x5,1x3`) and *as needed*.
- **Daylight saving and travel are handled.** 8:00 stays 8:00 when clocks change, while
  every-8-hours medicines stay 8 real hours apart. After a flight, `dosely profile zone Asia/Tokyo`
  keeps your clock times.
- **Reminders.** `dosely watch` shows a desktop notification on Windows, macOS and Linux when
  a dose is due.
- **A record of every dose**, whether taken, skipped, late or missed, with notes. `undo` fixes
  mistakes. Changing a schedule never rewrites the past.
- **Refills.** dosely tracks how many you have, counts down as you take them, and warns a week
  before you run out.
- **Adherence.** See how many doses you took, how many on time, and your streak of complete days.
- **Your own safety limits.** An as-needed maximum ("at most 8 in 24 hours") blocks the record
  if you go over. "Keep these two 4 hours apart" rules warn you, and point out clashing
  schedule times.
- **Measurements and symptoms.** Blood pressure, glucose, weight, temperature, pulse, oxygen,
  or anything else, with your doctor's target ranges and trends. Obvious typos (`1280/82`) are
  caught.
- **A doctor-visit summary.** Current medicines, doses taken, as-needed use, readings and
  symptoms, as Markdown or a printable web page. CSV exports too.
- **Profiles** for looking after someone else, such as a parent or a child, each with their
  own medicines and time zone.

## Install

You need [Node.js](https://nodejs.org) 20 or newer.

```console
$ git clone https://github.com/zeexduaa/dosely
$ cd dosely
$ npm install          # also builds it
$ npm install -g .     # puts the dosely command on your PATH
$ dosely init --name "Your name"
```

On Windows the same commands work in PowerShell. Without the global install, run
`node dist/src/cli.js` instead of `dosely`.

## Getting started

```console
$ dosely add Lisinopril --strength "10 mg" --schedule "daily 8am" --for "blood pressure" --stock 30
$ dosely add Metformin --schedule "8am, 8pm" --instructions "with food" --stock 60
$ dosely add Ibuprofen --strength "200 mg" --schedule "as needed" --max-per-day 6 --min-hours 6
$ dosely add Prednisolone --strength "5 mg" --schedule "daily 8am" --taper 8x3,6x3,4x3,2x3
$ dosely rule levothyroxine calcium 4 --note "pharmacist: calcium stops it being absorbed"
$ dosely target bp 90-130/60-85
$ dosely watch            # leave it running for reminders
```

Every day you use `dosely` (today's list), `dosely take NAME` or `dosely take all`,
`dosely skip NAME --note why`, and `dosely bp 128/82`. Run `dosely help` for everything.

### Commands

| | |
|---|---|
| `today`, `due`, `watch` | what to take now, what's missed, and desktop reminders |
| `take`, `skip`, `undo`, `history` | record doses (`--at "yesterday 8pm"`, `--amount 2`, `--note`) |
| `add`, `edit`, `list`, `show`, `stop`, `restart` | manage medications |
| `stock NAME 30`, `stock NAME +30`, `stock` | supply on hand, refills, and days left |
| `measure`, `measures`, `target`, `symptom`, `symptoms` | health readings and symptoms |
| `rule`, `rules` | keep two medicines apart, and check the schedule |
| `adherence`, `report`, `export` | summaries, doctor-visit report, CSV |
| `profile`, `--profile NAME` | look after more than one person |

Your data is in `%APPDATA%\dosely\dosely.json` (Windows), `~/Library/Application Support/dosely/`
(macOS) or `~/.local/share/dosely/` (Linux). Set `DOSELY_FILE` or `--file` to use another file.

## Important

dosely is a record-keeping tool, **not medical advice**, and it is not a medical device. It
doesn't know about drugs or interactions. Every limit and rule in it is one *you* entered from
the label, your doctor or your pharmacist. Always follow your prescriber's instructions, and if
a reminder is missed, don't double up without asking them. See
[docs/safety-and-privacy.md](docs/safety-and-privacy.md).

## Development

```console
$ npm install
$ npm test             # compiles, then runs the tests with Node's built-in runner
```

There are no runtime dependencies. The code is strict TypeScript, and the dev dependencies
are only `typescript` and `@types/node`. The [roadmap](ROADMAP.md) lists what's planned next,
including encryption at rest, a local web app, phone sync and printable medication cards.

## License

MIT
