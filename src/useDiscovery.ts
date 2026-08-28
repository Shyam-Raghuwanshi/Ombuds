import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * Kick off Firecrawl contact discovery and the local-news scan when a facility
 * is opened, and exactly once per facility per page load.
 *
 * Same guard as `useLazyTranslate`, for the same reason: React StrictMode runs
 * effects twice in development, and both runs would spend Firecrawl credits on
 * the same facility. Both actions are also cache-guarded on the server, but the
 * server guard only helps after the request has been paid for.
 *
 * Errors are returned rather than thrown. Every failure in this path has a
 * sentence written for it, and a family should see that sentence rather than a
 * card that is simply empty.
 */
export function useDiscovery(ccn: string, ready: boolean) {
  const enrich = useAction(api.enrichment.enrichFacility);
  const scanNews = useAction(api.news.scanFacilityNews);
  const started = useRef(new Set<string>());
  const [newsError, setNewsError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || started.current.has(ccn)) return;
    started.current.add(ccn);
    setNewsError(null);

    // Contact discovery writes its own outcome — including its failures — onto
    // the facility row, so the panel reads it from the reactive query rather
    // than from here.
    void enrich({ ccn }).catch((e) => {
      started.current.delete(ccn);
      console.error("contact discovery failed", e);
    });

    void scanNews({ ccn })
      .then((result) => setNewsError(result.error))
      .catch((e) => {
        console.error("news scan failed", e);
        setNewsError(
          "We could not search local news for this facility just now. The " +
            "inspection record below is the federal record and is unaffected.",
        );
      });
  }, [ccn, ready, enrich, scanNews]);

  return { newsError };
}
