# Roadmap

dosely already handles the daily routine: schedules, reminders, dose records, refills,
adherence, measurements, symptoms, safety limits you set, and a doctor-visit summary. This
is what's left, roughly in order. Help is welcome.

## Next

- [ ] **Encryption at rest.** An optional passphrase, with scrypt and AES-256-GCM from
      `node:crypto` (still no dependencies), and an unlock that lasts for a session.
- [ ] **Run reminders in the background.** Install `dosely watch` as a login item or service
      (Task Scheduler, launchd, systemd user unit) with one command. Add a snooze too.
- [ ] **A local web app.** `dosely serve` opens a page on localhost with today's checklist,
      big tap targets and charts of readings, for people who don't use a terminal.
- [ ] **Printable medication card.** A wallet-sized list of current medicines for emergencies
      and hospital visits.
- [ ] **Import** from pharmacy or app exports (Medisafe, Apple Health medications CSV), and
      from a FHIR `MedicationStatement`.
- [ ] **Charts** in the HTML report: blood pressure, glucose and weight over time, and doses
      taken per week.
- [ ] **Shell completion** for medication names.

## Later

- [ ] **Phone companion.** End-to-end encrypted sync with a small mobile app, so reminders
      reach your phone and doses can be ticked off there.
- [ ] **Caregiver mode.** Share one profile with a family member, who gets a notice when a
      dose is missed.
- [ ] **Appointments and lab results**, linked to the report.
- [ ] **Translations**, starting with Urdu, Arabic and Spanish, including medication
      instructions.
- [ ] **Accessibility review** of the web app: screen readers, large text, colour-blind-safe
      charts.
- [ ] **An optional interaction lookup**, against a reputable public database, clearly
      labelled and never replacing a pharmacist. It needs careful design, so it's not soon.

## Done

- [x] Time-zone-aware schedules: daily, weekdays, every N days, every N hours, cycles,
      tapers, as needed.
- [x] Dose records with grace periods, undo, notes, and a schedule history that keeps the
      past intact.
- [x] Stock, refill forecasts and adherence with streaks.
- [x] As-needed limits and keep-apart rules, with schedule clash detection.
- [x] Measurements with typo checks and targets, plus symptoms.
- [x] Doctor-visit report (Markdown, printable HTML) and CSV exports.
- [x] Profiles, desktop reminders on Windows, macOS and Linux, and a command line for all of
      it.
