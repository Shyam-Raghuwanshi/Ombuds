import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { Provenance } from "./FacilityDetail";
import { fmtDate } from "./severity";

/**
 * How to reach this facility — the half of the record the federal government
 * does not publish.
 *
 * CMS gives a telephone number and nothing else: no website column, no email
 * column, for any of the 14,690 certified facilities in the country. Everything
 * in this panel was found on the open web, and the panel says so, every time,
 * with the page it was read from linked so a family can go and check.
 *
 * The failure states matter as much as the success state. A facility with no
 * website, or a website with no address on it, keeps its place here with its
 * phone number and its full inspection record. Quietly dropping the facilities
 * we cannot email would be the same filtering that a referral service does — it
 * is the specific thing this product exists to argue against.
 */

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function Chips({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="mt-3">
      <dt className="text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">{label}</dt>
      <dd className="mt-1 flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="rounded border border-[#d8dce1] px-2 py-0.5 text-[14px] dark:border-[#2b3236]"
          >
            {value}
          </span>
        ))}
      </dd>
    </div>
  );
}

/**
 * The three Firecrawl steps, shown as a trail rather than a spinner.
 *
 * This is here because the dependency is worth making visible: a federal
 * provider number becomes an email address only by searching the open web for
 * the facility's own site, finding its contact page, and reading the address
 * off it. Nothing about the inspection record gets us there.
 */
function DiscoveryTrail({
  status,
  website,
  sourceUrl,
}: {
  status: string;
  website: string | null;
  sourceUrl: string | null;
}) {
  const steps = [
    {
      label: "Searched the web for their own website",
      detail: "The federal record has no website field.",
      done: website !== null,
      failed: status === "no_website_found",
    },
    {
      label: "Found their contact page",
      detail: website ?? "",
      done: sourceUrl !== null,
      failed: status === "no_email_found",
    },
    {
      label: "Read an address off the page",
      detail: sourceUrl ?? "",
      done: status === "discovered",
      failed: status === "no_email_found",
    },
  ];

  return (
    <ol className="mt-4 space-y-1.5 border-l border-[#d8dce1] pl-4 dark:border-[#2b3236]">
      {steps.map((step) => (
        <li key={step.label} className="text-[14px]">
          <span
            aria-hidden
            className="mr-2 text-[#5b6570] dark:text-[#9aa4ad]"
          >
            {step.done ? "✓" : step.failed ? "—" : "·"}
          </span>
          <span className={step.done ? "" : "text-[#5b6570] dark:text-[#9aa4ad]"}>
            {step.label}
          </span>
          {step.detail && (
            <span className="ml-1 break-all text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
              {step.detail}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ContactPanel({ ccn }: { ccn: string }) {
  const card = useQuery(api.enrichment.contactCard, { ccn });

  if (card === undefined) {
    return (
      <section className="mt-8">
        <h2 className="text-xl font-semibold">How to reach them</h2>
        <p className="mt-2 text-[#5b6570] dark:text-[#9aa4ad]">Loading…</p>
      </section>
    );
  }
  if (card === null) return null;

  const phone = formatPhone(card.phone);

  return (
    <section className="mt-8 rounded border border-[#d8dce1] p-5 dark:border-[#2b3236]">
      <h2 className="text-xl font-semibold">How to reach them</h2>
      <p className="mt-1 max-w-3xl text-[15px] text-[#5b6570] dark:text-[#9aa4ad]">
        The federal record publishes a phone number for this facility and
        nothing else — no website, no email address. Everything below was found
        on the open web.
      </p>

      <dl className="mt-4">
        <div>
          <dt className="text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
            Telephone
          </dt>
          <dd className="text-[17px] font-medium">
            <a href={`tel:${card.phone}`} className="underline underline-offset-4">
              {phone}
            </a>
          </dd>
          <Provenance>Federal record, CMS Provider Data Catalog.</Provenance>
        </div>

        {card.contactStatus === "discovered" && card.contactEmail && (
          <div className="mt-4">
            <dt className="text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
              Email
            </dt>
            <dd className="text-[17px] font-medium break-all">
              <a
                href={`mailto:${card.contactEmail}`}
                className="underline underline-offset-4"
              >
                {card.contactEmail}
              </a>
            </dd>
            <Provenance>
              Found on{" "}
              <a
                href={card.contactSourceUrl ?? card.website ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2 break-all"
              >
                {card.contactSourceUrl ?? card.website}
              </a>
              {card.enrichedAt ? ` on ${fmtDate(card.enrichedAt)}` : ""}. This is
              the facility's own published address, not a referral service.
            </Provenance>
          </div>
        )}
      </dl>

      {/* Every non-success outcome gets a sentence. None of them hide the
          facility, and none of them are shown as if they were an error in the
          inspection record. */}
      {card.contactStatus === "no_website_found" && (
        <p className="mt-4 max-w-3xl text-[15px]">
          We could not find a website for this facility. Many smaller homes do
          not have one. Their phone number above is from the federal record, and
          their full inspection history is below.
        </p>
      )}

      {card.contactStatus === "no_email_found" && (
        <p className="mt-4 max-w-3xl text-[15px]">
          We found their website but no email address published on it, so there
          is no address to write to. Their phone number above is from the
          federal record.
        </p>
      )}

      {card.contactStatus === "failed" && card.enrichmentError && (
        <p className="mt-4 max-w-3xl text-[15px]">{card.enrichmentError}</p>
      )}

      {(card.contactStatus === "pending" ||
        card.contactStatus === "unstarted") && (
        <p className="mt-4 flex items-center gap-2 text-[15px] text-[#5b6570] dark:text-[#9aa4ad]">
          <span
            aria-hidden
            className="inline-block h-3 w-3 animate-pulse rounded-full bg-[#d8dce1] dark:bg-[#2b3236]"
          />
          Looking for a way to contact them…
        </p>
      )}

      {card.contactStatus !== "unstarted" && (
        <DiscoveryTrail
          status={card.contactStatus}
          website={card.website}
          sourceUrl={card.contactSourceUrl}
        />
      )}

      {card.website && (
        <p className="mt-4 text-[15px]">
          <a
            href={card.website}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4"
          >
            Visit their website
          </a>
        </p>
      )}

      {card.enrichment && (
        <div className="mt-5 border-t border-[#d8dce1] pt-4 dark:border-[#2b3236]">
          <h3 className="text-[15px] font-medium">
            What the facility says about itself
          </h3>
          <dl>
            <Chips label="Care levels offered" values={card.enrichment.careLevels} />
            <Chips label="Room types" values={card.enrichment.roomTypes} />
            <Chips label="Amenities" values={card.enrichment.amenities} />
            {card.enrichment.publishedPricing && (
              <div className="mt-3">
                <dt className="text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
                  Published pricing
                </dt>
                <dd className="text-[15px]">
                  {card.enrichment.publishedPricing}
                </dd>
              </div>
            )}
          </dl>
          <Provenance>
            Taken from the facility's own marketing pages
            {card.enrichedAt ? ` on ${fmtDate(card.enrichedAt)}` : ""}. These are
            the facility's claims about itself, not a federal record and not
            anything we have verified.
          </Provenance>
        </div>
      )}
    </section>
  );
}
