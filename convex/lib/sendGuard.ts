/**
 * The guard that stops us emailing real nursing homes.
 *
 * CLAUDE.md section 7.1 is not a preference: these are understaffed places
 * caring for real, vulnerable people, and they do not get hackathon traffic.
 * Every outbound address in the product passes through `resolveRecipient`
 * below, and it is the only function permitted to return a facility's own
 * address.
 *
 * Two independent flags, BOTH off by default, must be set before a single real
 * facility can be written to:
 *
 *   OMBUDS_DEMO_MODE=false        deliberately leaving the sandbox
 *   OMBUDS_ALLOW_REAL_SENDS=true  deliberately arming live sends
 *
 * Either one on its own routes to an inbox we control. Two flags rather than
 * one because a single flag is exactly the kind of thing that gets flipped
 * while debugging and forgotten.
 */

export type SendMode =
  /** Routed to an inbox we own. A persona replies. Nothing leaves for a home. */
  | "demo"
  /** Addressed to the facility's own discovered address. Requires both flags. */
  | "live";

export type Recipient = {
  /** Where the message is actually addressed. */
  to: string;
  /** Whether this thread is a simulation. Drives the label in the UI. */
  simulated: boolean;
  /**
   * The address we WOULD have written to. Always shown next to a simulated
   * thread so the screen never implies we contacted a home that we did not.
   */
  intendedTo: string | null;
  mode: SendMode;
};

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

/** Demo mode is ON unless someone has explicitly turned it off. */
export function demoModeEnabled(): boolean {
  return flag("OMBUDS_DEMO_MODE", true);
}

/** Live sending is OFF unless someone has explicitly armed it. */
export function realSendsArmed(): boolean {
  return flag("OMBUDS_ALLOW_REAL_SENDS", false);
}

/**
 * True only when both flags agree. Written as one expression, in one place, so
 * there is exactly one line in the codebase to read when asking "could this
 * have emailed a real facility?".
 */
export function liveSendingPermitted(): boolean {
  return !demoModeEnabled() && realSendsArmed();
}

/**
 * Decide where one inquiry is actually addressed.
 *
 * `facilityEmail` is what Firecrawl found on the open web, and may be null —
 * a third of facilities publish no address at all, which is an ordinary
 * outcome rather than an error (CLAUDE.md section 4).
 */
export function resolveRecipient(args: {
  facilityEmail: string | null;
  demoInboxEmail: string;
}): Recipient {
  if (liveSendingPermitted() && args.facilityEmail) {
    return {
      to: args.facilityEmail,
      simulated: false,
      intendedTo: null,
      mode: "live",
    };
  }
  return {
    to: args.demoInboxEmail,
    simulated: true,
    intendedTo: args.facilityEmail,
    mode: "demo",
  };
}

/**
 * Whether a demo inquiry is put on the wire through AgentMail at all.
 *
 * With real delivery on, the family's letter is a genuine AgentMail send with a
 * genuine delivery lifecycle; the facility's answer is played by a persona.
 * With it off, the send is recorded locally and no quota is spent — which is
 * what makes it possible to rehearse the demo the fifty times CLAUDE.md's risk
 * register asks for, against a 100-message daily cap.
 */
export function demoRealDelivery(): boolean {
  return flag("OMBUDS_DEMO_REAL_DELIVERY", true);
}
