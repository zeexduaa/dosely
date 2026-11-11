# Safety and privacy

## What dosely is, and isn't

dosely is a notebook that's good with time. It helps you take what you've been prescribed when
you've been told to take it, and remember what happened. It is **not** medical advice, a
medical device, or a replacement for your doctor or pharmacist.

- **It doesn't know anything about drugs.** There is no drug database and no interaction
  checking. A medicine you add is just a name to dosely.
- **Every limit is yours.** As-needed maximums, minimum gaps between doses and "keep apart"
  rules are only what you typed in. Get them from the label, your doctor or your pharmacist.
  If you leave them out, dosely checks nothing.
- **It never judges a reading.** Typos are caught (a blood pressure of 1280/82 isn't
  recorded), but dosely doesn't say whether a real reading is good or bad. It flags readings
  outside a target range only if you entered one.
- **Missed a dose?** dosely shows it as missed, and that's all. Whether to take it late, skip
  it or double up is a question for your prescriber or the leaflet. dosely never suggests
  doubling up.
- **Reminders can fail.** `dosely watch` only works while it's running and the computer is
  awake. A notification can be missed or turned off. Don't let dosely be the only way you
  remember a medicine that matters.

### How the safety checks behave

| Check | When | What happens |
|---|---|---|
| Daily maximum (`--max-per-day`) | the units taken in any 24 hours would go over | **Not recorded.** It says when the next dose fits. `--force` records it anyway, for when your doctor told you otherwise. |
| Minimum gap (`--min-hours`) | too soon after the last dose | Recorded, with a warning and the time it would have been fine |
| Keep-apart rule (`dosely rule`) | taken within N hours of the other medicine | Recorded, with a warning |
| Keep-apart rule, schedule | two regular dose times are too close | Shown in `today` and `rules` |

## Time

- Clock-time doses keep their wall-clock time across daylight saving changes. A dose at 01:30
  on the night clocks go forward moves to 02:30. On the night they go back, it's taken once,
  at the first 01:30.
- Every-N-hours doses count real hours, so they stay N hours apart through a clock change.
- `dosely profile zone NEW/ZONE` moves a profile to a new time zone, and clock times stay the
  same locally. Check every-N-hours medicines after travelling, because their next dose is
  still N real hours after the last one.

## Privacy

- **Local only.** Everything is in one JSON file on your computer. dosely makes no network
  connections, has no account and no analytics, and has no runtime dependencies.
- **File permissions.** On macOS and Linux the data file and its backup are readable only by
  you. On Windows they live in your user profile folder.
- **Not encrypted, yet.** The file is plain JSON, so anyone who can read your files can read
  it. Use full-disk encryption (BitLocker, FileVault, LUKS), which you should have anyway.
  Encryption at rest is the first item on the roadmap.
- **Exports are plain text.** A report or CSV holds your health information. Share it
  deliberately and delete it when you're done. Exports won't overwrite an existing file
  unless you pass `--force`. CSV cells that a spreadsheet would treat as formulas are
  neutralized.
- **Safe saving.** Every save writes a temporary file, flushes it to disk and renames it over
  the old one. A crash can't leave half a file, and the previous version is kept as
  `dosely.json.bak`.
- **Notifications** show the medicine's name on your screen, and possibly on a lock screen. If
  that's a concern, check your system's notification settings.
