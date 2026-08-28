import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { Provenance } from "./FacilityDetail";
import { fmtDate } from "./severity";

/**
 * Recent local reporting, found with Firecrawl search.
 *
 * This section exists because of a timing gap. A state survey is written up,
 * disputed, and finally published to CMS months after the inspector walked out,
 * so the federal record on this page is, by construction, old news. The county
 * paper runs the lawsuit the week it is filed.
 *
 * Two presentation rules, both deliberate:
 *
 * Nothing here is red. Red in this product means a federal inspector found that
 * a resident was harmed. A newspaper report of an allegation is a different
 * kind of fact and must not be dressed as the same one.
 *
 * Every item names its outlet, carries its link, and is labelled as reporting
 * rather than as a finding. We relay what was published and let the reader
 * judge it.
 */

const CONCERN_LABEL: Record<string, string> = {
  informational: "Local coverage",
  concerning: "Raises a concern",
  serious: "Serious allegation reported",
};

/** Weight, not colour — see the note above about red. */
const CONCERN_STYLE: Record<string, string> = {
  informational: "text-[#5b6570] dark:text-[#9aa4ad]",
  concerning: "font-medium",
  serious: "font-semibold",
};

export function NewsPanel({
  ccn,
  error,
}: {
  ccn: string;
  error: string | null;
}) {
  const news = useQuery(api.news.facilityNews, { ccn });

  return (
    <section className="mt-8">
      <h2 className="text-xl font-semibold">Recent local reporting</h2>
      <p className="mt-1 max-w-3xl text-[15px] text-[#5b6570] dark:text-[#9aa4ad]">
        Federal inspection results take months to be published. Local news does
        not. This is what the press has reported about this facility in the past
        year.
      </p>

      {error && <p className="mt-3 max-w-3xl text-[15px]">{error}</p>}

      {news === undefined && (
        <p className="mt-3 text-[#5b6570] dark:text-[#9aa4ad]">
          Searching local news…
        </p>
      )}

      {news && !error && news.scanned && news.items.length === 0 && (
        // Deliberately distinct from "we have not looked yet". Finding nothing
        // is a real answer and a family should be able to read it as one.
        <p className="mt-3 max-w-3xl text-[15px]">
          We searched local news from the past year and found no coverage of
          this facility.
          {news.scannedAt ? ` Checked ${fmtDate(news.scannedAt)}.` : ""}
        </p>
      )}

      {news && !news.scanned && !error && (
        <p className="mt-3 text-[#5b6570] dark:text-[#9aa4ad]">
          Not searched yet.
        </p>
      )}

      {news && news.items.length > 0 && (
        <>
          <ul className="mt-3">
            {news.items.map((item) => (
              <li
                key={item._id}
                className="border-t border-[#d8dce1] py-4 dark:border-[#2b3236]"
              >
                <p
                  className={`text-[13px] uppercase tracking-wide ${
                    CONCERN_STYLE[item.concernLevel] ?? ""
                  }`}
                >
                  {CONCERN_LABEL[item.concernLevel] ?? item.concernLevel}
                </p>
                <h3 className="mt-1 text-[17px] font-medium">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline underline-offset-4"
                  >
                    {item.title}
                  </a>
                </h3>
                <p className="mt-1 max-w-3xl text-[16px] leading-relaxed">
                  {item.whyItMatters}
                </p>
                <Provenance>
                  Reported by {item.outlet}
                  {item.publishedAt
                    ? `, ${new Date(item.publishedAt).getUTCFullYear()}`
                    : ", date not published"}
                  . This is a news report, not a federal inspection finding.
                  Relevance judged by {item.model}.
                </Provenance>
              </li>
            ))}
          </ul>
          <Provenance>
            Found by searching the open web. We only publish stories confirmed to
            be about this specific facility — chains share one name across many
            buildings, so anything we were not sure about was left out.
          </Provenance>
        </>
      )}
    </section>
  );
}
