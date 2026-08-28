import { useEffect, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * Kick off translation + risk summary for a facility the moment it is viewed —
 * and exactly once per facility per page load.
 *
 * The guard is not paranoia. React StrictMode runs effects twice in dev, and
 * both runs would find an empty cache and both would pay for the same tokens.
 * `translateFacility` de-duplicates on write, but only after the money is
 * spent, so the second call has to be stopped here. CLAUDE.md section 10.
 */
export function useLazyTranslate(ccn: string, ready: boolean) {
  const translate = useAction(api.deficiencies.translateFacility);
  const summarize = useAction(api.deficiencies.summarizeFacilityRisk);
  const started = useRef(new Set<string>());

  useEffect(() => {
    if (!ready || started.current.has(ccn)) return;
    started.current.add(ccn);
    void translate({ ccn })
      .then(() => summarize({ ccn }))
      .catch((e) => {
        // Leave the row in its "translating…" state rather than showing a
        // half-written sentence, and allow a retry on the next mount.
        started.current.delete(ccn);
        console.error("lazy translate failed", e);
      });
  }, [ccn, ready, translate, summarize]);
}
