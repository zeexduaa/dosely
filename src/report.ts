/**
 * A summary to take to a doctor's appointment, and CSV exports.
 *
 * The report is built once as plain sections and tables, then written as
 * Markdown (for the terminal or a notes app) or as a self-contained HTML page
 * that prints cleanly on paper. It states plainly that the patient kept these
 * records themselves.
 *
 * CSV cells that a spreadsheet would read as a formula (starting with = + - @)
 * are prefixed with an apostrophe, so a note can't run anything when opened.
 */

import { type Profile, medLabel, medicationById } from "./model.js";
import { adherence } from "./adherence.js";
import { dayBounds } from "./doses.js";
import { describe } from "./schedule.js";
import { supply } from "./stock.js";
import { formatReading, outsideTarget, summarize, summarizeSymptoms, targetText, KINDS } from "./health.js";
import { formatInstant, localParts } from "./time.js";
import { VERSION } from "./version.js";

export interface Table {
  headers: string[];
  rows: string[][];
}

export interface Section {
  title: string;
  text?: string[];
  table?: Table;
}

export interface Report {
  title: string;
  subtitle: string;
  sections: Section[];
}

const pct = (n: number | undefined) => (n === undefined ? "–" : `${n}%`);

export function build(profile: Profile, from: string, to: string, now: number): Report {
  const [start] = dayBounds(profile, from);
  const [, end] = dayBounds(profile, to);
  const zone = profile.zone;
  const sections: Section[] = [];
  const current = profile.medications.filter((m) => !m.archived);

  sections.push({
    title: "Current medications",
    text: current.length ? undefined : ["None recorded."],
    table: current.length ? {
      headers: ["Medication", "How it's taken", "For", "Instructions", "Prescriber", "Since"],
      rows: current.map((m) => [medLabel(m), describe(m.regimen, m.unit), m.purpose ?? "", m.instructions ?? "",
                                m.prescriber ?? "", m.regimen.start]),
    } : undefined,
  });

  const stopped = profile.medications.filter((m) => m.archived &&
    profile.doses.some((d) => d.med === m.id && d.at >= start! && d.at < end!));
  if (stopped.length) {
    sections.push({ title: "Stopped during this period", text: stopped.map((m) => `${medLabel(m)}: ${describe(m.regimen, m.unit)}`) });
  }

  const scheduled = current.filter((m) => m.regimen.schedule.kind !== "as-needed");
  if (scheduled.length) {
    const report = adherence(profile, from, to, now, scheduled);
    sections.push({
      title: "Doses taken",
      text: [`Overall: ${pct(report.total.percent)} of ${report.total.scheduled} scheduled doses taken ` +
             `(${pct(report.total.onTimePercent)} within ${profile.settings.graceMinutes} minutes of the time).`],
      table: {
        headers: ["Medication", "Scheduled", "Taken on time", "Late", "Skipped", "Missed", "Taken"],
        rows: report.meds.map((m) => [medLabel(m.med), String(m.scheduled), String(m.onTime), String(m.late),
                                      String(m.skipped), String(m.missed), pct(m.percent)]),
      },
    });
  }

  const asNeeded = current.filter((m) => m.regimen.schedule.kind === "as-needed");
  if (asNeeded.length) {
    sections.push({
      title: "As-needed medications",
      table: {
        headers: ["Medication", "Times taken", "Total", "Most in one day"],
        rows: asNeeded.map((m) => {
          const taken = profile.doses.filter((d) => d.med === m.id && d.status === "taken" && d.at >= start! && d.at < end!);
          const perDay = new Map<string, number>();
          for (const d of taken) {
            const day = localParts(d.at, zone).date;
            perDay.set(day, (perDay.get(day) ?? 0) + d.amount);
          }
          const total = taken.reduce((s, d) => s + d.amount, 0);
          return [medLabel(m), String(taken.length), `${total} ${m.unit}(s)`, perDay.size ? String(Math.max(...perDay.values())) : "0"];
        }),
      },
    });
  }

  const measures = summarize(profile, start!, end!);
  if (measures.length) {
    sections.push({
      title: "Measurements",
      table: {
        headers: ["Measurement", "Readings", "Average", "Range", "Change", "Latest", "Target", "Outside target"],
        rows: measures.map((s) => {
          const join = (f: (v: (typeof s.values)[number]) => string) => s.values.map(f).join(" / ");
          const target = profile.targets[s.kind];
          return [`${s.label} (${s.unit})`, String(s.count), join((v) => String(v.average)), join((v) => `${v.min}–${v.max}`),
                  s.values.every((v) => v.change !== undefined) ? join((v) => (v.change! > 0 ? `+${v.change}` : String(v.change))) : "–",
                  `${formatReading(s.latest)} (${formatInstant(s.latest.at, zone)})`,
                  target ? targetText(target) : "", target ? String(s.outside) : ""];
        }),
      },
    });
    const flagged = profile.measurements
      .filter((m) => m.at >= start! && m.at < end! && outsideTarget(profile, m).length)
      .sort((a, b) => a.at - b.at).slice(-10);
    if (flagged.length) {
      sections.push({ title: "Readings outside target (latest 10)",
        text: flagged.map((m) => `${formatInstant(m.at, zone)}: ${KINDS[m.kind]?.label ?? m.kind} ${formatReading(m)} ` +
                                 `(${outsideTarget(profile, m).join(", ")})${m.note ? ` – ${m.note}` : ""}`) });
    }
  }

  const symptoms = summarizeSymptoms(profile, start!, end!);
  if (symptoms.length) {
    sections.push({
      title: "Symptoms",
      table: {
        headers: ["Symptom", "Times noted", "Average severity (0–10)", "Worst", "Last noted"],
        rows: symptoms.map((s) => [s.name, String(s.count), String(s.averageSeverity), String(s.worst), formatInstant(s.last, zone)]),
      },
    });
  }

  const notes = profile.doses.filter((d) => d.note && d.at >= start! && d.at < end!).sort((a, b) => a.at - b.at)
    .map((d) => {
      const m = medicationById(profile, d.med);
      return `${formatInstant(d.at, zone)}: ${m ? medLabel(m) : "?"} ${d.status} – ${d.note}`;
    });
  if (notes.length) sections.push({ title: "Notes on doses", text: notes.slice(-15) });

  if (profile.rules.length) {
    sections.push({ title: "Timing rules I follow", text: profile.rules.map((r) => {
      const a = medicationById(profile, r.a);
      const b = medicationById(profile, r.b);
      return `${a ? medLabel(a) : "?"} and ${b ? medLabel(b) : "?"}: at least ${r.hours} hours apart${r.note ? ` (${r.note})` : ""}`;
    }) });
  }

  const low = current.map((m) => supply(profile, m, now)).filter((s) => s?.low);
  if (low.length) {
    sections.push({ title: "Refills needed", text: low.map((s) => `${medLabel(s!.med)}: ${s!.count} ${s!.med.unit}(s) left` +
      (s!.runsOut ? `, runs out about ${s!.runsOut}` : "")) });
  }

  return {
    title: `Health summary: ${profile.name}`,
    subtitle: `${from} to ${to}. Kept by the patient with dosely ${VERSION}; times are ${zone}. ` +
              `This is a personal record, not a medical record.`,
    sections,
  };
}

// -- writing it out --------------------------------------------------------------------------------

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function toMarkdown(report: Report): string {
  const out = [`# ${report.title}`, "", `_${report.subtitle}_`, ""];
  for (const section of report.sections) {
    out.push(`## ${section.title}`, "");
    for (const line of section.text ?? []) out.push(section.table ? line : `- ${line}`);
    if (section.text?.length) out.push("");
    if (section.table) {
      out.push(`| ${section.table.headers.map(mdCell).join(" | ")} |`, `|${section.table.headers.map(() => "---").join("|")}|`);
      for (const row of section.table.rows) out.push(`| ${row.map(mdCell).join(" | ")} |`);
      out.push("");
    }
  }
  return out.join("\n");
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function toHtml(report: Report): string {
  const body = report.sections.map((s) => {
    const text = s.table ? (s.text ?? []).map((t) => `<p>${escapeHtml(t)}</p>`).join("")
      : `<ul>${(s.text ?? []).map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
    const table = s.table ? `<table><thead><tr>${s.table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
      `<tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
    return `<section><h2>${escapeHtml(s.title)}</h2>${text}${table}</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; } h2 { font-size: 1.1rem; margin: 1.6rem 0 .5rem; border-bottom: 1px solid #ccc; }
  .sub { color: #555; margin-top: 0; } table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
  th { background: #f4f4f4; } ul { padding-left: 1.2rem; } section { break-inside: avoid; }
  @media print { body { margin: 0; font-size: 11pt; } th { background: none; } }
</style></head>
<body><h1>${escapeHtml(report.title)}</h1><p class="sub">${escapeHtml(report.subtitle)}</p>
${body}
</body></html>
`;
}

// -- CSV -------------------------------------------------------------------------------------------

export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(headers: string[], rows: (string | number)[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function dosesCsv(profile: Profile): string {
  const zone = profile.zone;
  return csv(["date", "time", "medication", "status", "amount", "unit", "scheduled_for", "note"],
    [...profile.doses].sort((a, b) => a.at - b.at).map((d) => {
      const med = medicationById(profile, d.med);
      const p = localParts(d.at, zone);
      return [p.date, p.time, med ? medLabel(med) : d.med, d.status, d.amount, med?.unit ?? "",
              d.slot && !d.slot.includes("#") ? d.slot.replace("T", " ") : d.slot ?? "", d.note ?? ""];
    }));
}

export function measurementsCsv(profile: Profile): string {
  const zone = profile.zone;
  return csv(["date", "time", "kind", "value", "unit", "note"],
    [...profile.measurements].sort((a, b) => a.at - b.at).map((m) => {
      const p = localParts(m.at, zone);
      return [p.date, p.time, m.kind, m.values.join("/"), m.unit, m.note ?? ""];
    }));
}

export function symptomsCsv(profile: Profile): string {
  const zone = profile.zone;
  return csv(["date", "time", "symptom", "severity", "note"],
    [...profile.symptoms].sort((a, b) => a.at - b.at).map((s) => {
      const p = localParts(s.at, zone);
      return [p.date, p.time, s.name, s.severity, s.note ?? ""];
    }));
}
