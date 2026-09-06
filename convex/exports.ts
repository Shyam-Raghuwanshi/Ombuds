import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { HARM_RANK } from "./lib/severity";

/**
 * The shortlist, as a file the family keeps.
 *
 * Choosing a care home is not done in one sitting and it is not done alone. It
 * happens over weeks, in hospital corridors, and the decision gets argued about
 * with a sibling who has never seen this screen. A board that only exists
 * behind a session is no use in that conversation.
 *
 * CSV rather than PDF, deliberately. This is a table of facts about twelve
 * facilities, and the thing a family actually does with it is sort it, filter
 * it, and send it to someone. A spreadsheet does all three; a PDF does none of
 * them and only looks more finished.
 *
 * Every column carries its provenance. The federal columns say when the survey
 * happened; the facility's own answers say when they said it and whether the
 * answer came from a simulated thread. Nothing in the file lets a reader
 * mistake what a home claimed for what an inspector found — the same rule the
 * screen follows (CLAUDE.md section 8).
 */

/** RFC 4180: quote every field, double any quote inside it. */
function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

const csvRow = (cells: Array<string | number | boolean | null | undefined>) =>
  cells.map(csvCell).join(",");

/** ISO date, or empty. Dates in this file are read by people and by machines. */
function isoDate(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "not answered";
  return value ? "yes" : "no";
}

function money(low: number | null, high: number | null): string {
  if (low === null && high === null) return "not answered";
  if (low !== null && high !== null && low !== high) return `${low}-${high}`;
  return String(low ?? high);
}

const HEADERS = [
  "Facility",
  "City",
  "State",
  "Phone",
  "CMS certification number",
  // --- the federal record -------------------------------------------------
  "CMS overall rating (1-5)",
  "Abuse citation flagged by CMS",
  "Special focus status",
  "Actual-harm citations",
  "Immediate-jeopardy citations",
  "Most recent inspection",
  "RN hours per resident per day (weekend)",
  // --- what the facility told us -------------------------------------------
  "Conversation status",
  "Rounds",
  "Has an opening",
  "Monthly cost (USD)",
  "One-time fee (USD)",
  "Waitlist (weeks)",
  "Tour offered",
  "Night staffing (as stated by the facility)",
  "Questions left unanswered",
  "Parser confidence (0-1)",
  "They last replied",
  "Answer may be out of date",
  "Simulated thread",
];

export const boardCsv = action({
  args: { searchId: v.id("searches") },
  returns: v.union(
    v.null(),
    v.object({
      url: v.string(),
      filename: v.string(),
      rows: v.number(),
    }),
  ),
  handler: async (
    ctx,
    { searchId },
  ): Promise<{ url: string; filename: string; rows: number } | null> => {
    // `board` proves ownership itself and returns null to anyone else, so this
    // never needs to re-check and can never disagree with the screen.
    const board = await ctx.runQuery(api.searches.board, { searchId });
    if (!board) return null;

    const generatedAt = new Date();
    const lines: string[] = [];

    // A preamble, because this file will be opened by someone who was not
    // there when it was made — and possibly forwarded to someone who has never
    // heard of this product.
    lines.push(
      csvRow([
        `Ombuds — ${board.search.label}, ${board.search.careLevel} care near ZIP ${board.search.zip}`,
      ]),
    );
    lines.push(
      csvRow([
        `Safety columns are the federal CMS inspection record. Availability columns are what each facility told us by email, on the date shown. They are not the same kind of fact.`,
      ]),
    );
    lines.push(csvRow([`Exported ${generatedAt.toISOString()}`]));
    if (board.search.demoMode) {
      lines.push(
        csvRow([
          `DEMO MODE: replies in this export were written by a seeded persona from an inbox we control, not by the facility. No real facility was emailed.`,
        ]),
      );
    }
    lines.push("");
    lines.push(csvRow(HEADERS));

    // Worst safety record first. A family scanning a spreadsheet reads from the
    // top, and the homes that hurt someone are the ones they must not miss.
    const rows = [...board.rows].sort((a, b) => {
      const harm =
        b.immediateJeopardy * HARM_RANK.immediate_jeopardy +
        b.actualHarm * HARM_RANK.actual_harm -
        (a.immediateJeopardy * HARM_RANK.immediate_jeopardy +
          a.actualHarm * HARM_RANK.actual_harm);
      return harm !== 0 ? harm : a.facilityName.localeCompare(b.facilityName);
    });

    for (const r of rows) {
      lines.push(
        csvRow([
          r.facilityName,
          r.city,
          r.state,
          r.phone,
          r.ccn,
          r.overallRating > 0 ? r.overallRating : "not rated by CMS",
          r.abuseIcon ? "yes" : "no",
          r.specialFocusStatus ?? "",
          r.actualHarm,
          r.immediateJeopardy,
          isoDate(r.latestSurveyDate),
          // Absent is absent. A blank staffing figure printed as 0.0 would put
          // a false accusation next to a real facility's name.
          r.rnHoursWeekend === null ? "not published" : r.rnHoursWeekend,
          r.noEmailFound ? "no published email address" : r.status,
          r.rounds,
          yesNo(r.hasOpening),
          money(r.monthlyCostLow, r.monthlyCostHigh),
          r.oneTimeFee === null ? "not answered" : r.oneTimeFee,
          r.waitlistWeeks === null ? "not answered" : r.waitlistWeeks,
          yesNo(r.tourOffered),
          r.staffRatioNights ?? "not answered",
          r.unansweredLabels.join("; "),
          r.confidence === null ? "" : r.confidence,
          isoDate(r.lastInboundAt),
          r.stale ? "yes — older than 30 days" : "no",
          r.simulated ? `yes — ${r.personaLabel ?? "seeded persona"}` : "no",
        ]),
      );
    }

    // A BOM, so Excel opens a UTF-8 file with the right encoding instead of
    // mangling every name with an accent in it.
    const csv = "﻿" + lines.join("\r\n") + "\r\n";
    const storageId = await ctx.storage.store(
      new Blob([csv], { type: "text/csv" }),
    );
    const url = await ctx.storage.getUrl(storageId);
    if (!url) throw new Error("stored the export but could not get a URL for it");

    const slug = board.search.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      url,
      filename: `ombuds-${slug || "search"}-${isoDate(generatedAt.getTime())}.csv`,
      rows: rows.length,
    };
  },
});
