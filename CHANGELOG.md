# Changelog

## Unreleased (0.1.0)

First version.

- Schedules: daily times with per-time amounts, weekdays, every N days, every N hours (real
  hours), on/off cycles, tapers and as-needed, all aware of time zones and DST.
- Dose records: taken, skipped, late and missed, with a grace period, notes and undo. Changing
  a schedule keeps the old one for history, and doses from before a medicine was added don't
  count as missed.
- Stock tracking with refill forecasts; adherence with on-time rates and streaks.
- Safety limits the user enters: as-needed maximums (blocking) and minimum gaps, plus
  keep-apart rules with schedule clash detection.
- Measurements (blood pressure, glucose, weight, temperature, pulse, SpO2, custom kinds) with
  typo checks, targets and trends; symptom logging.
- A doctor-visit summary in Markdown or printable HTML; CSV exports that neutralize formulas.
- Profiles with their own time zones, for caregivers.
- A command line with desktop reminders (`dosely watch`) on Windows, macOS and Linux.
