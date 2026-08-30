import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { fmtTime } from "./board";
import { Empty, Loading } from "./ui";

/**
 * The actual conversation, reactive.
 *
 * A family should be able to read exactly what was sent on their behalf and
 * exactly what came back, in their own words, without taking anything on trust.
 * That is also what makes the follow-up round legible: you can see the reply
 * that dodged the question, and then the message that asked again.
 */

function Message({
  message,
}: {
  message: {
    id: string;
    direction: string;
    round: number;
    subject: string;
    body: string;
    fromAddress: string;
    simulated: boolean;
    model: string | null;
    persona: string | null;
    createdAt: number;
  };
}) {
  const outbound = message.direction === "outbound";
  return (
    <li
      className={`rounded border p-4 ${
        outbound
          ? "border-rule"
          : "border-rule bg-sunk  "
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-semibold">
          {outbound ? "The family" : message.fromAddress || "The facility"}
        </span>
        <span className="text-[14px] text-muted">
          {fmtTime(message.createdAt)} · round {message.round}
        </span>
        {message.simulated && (
          <span className="rounded border border-rule px-1.5 py-0.5 text-[14px] font-medium text-muted">
            Simulated
            {message.persona ? ` · ${message.persona.replace(/_/g, " ")}` : ""}
          </span>
        )}
      </div>

      {outbound && (
        <p className="mt-1 text-[14px] text-muted">
          {message.subject}
        </p>
      )}

      <pre className="mt-3 whitespace-pre-wrap font-sans text-[16px] leading-relaxed">
        {message.body}
      </pre>

      {outbound && message.model === "no-model-nudge" && (
        <p className="mt-3 text-[14px] text-muted">
          A nudge says the same thing to everyone, so no model wrote this one.
        </p>
      )}

      {outbound && message.model && message.model !== "no-model-nudge" && (
        <p className="mt-3 text-[14px] text-muted">
          Drafted by {message.model} in the family's words, from what they told
          us they needed.
        </p>
      )}
    </li>
  );
}

export function ThreadView({
  inquiryId,
  onBack,
}: {
  inquiryId: Id<"inquiries">;
  onBack: () => void;
}) {
  const thread = useQuery(api.email.thread, { inquiryId });

  if (thread === undefined) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Loading what="Loading this conversation…" />
      </div>
    );
  }
  if (thread === null) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <button onClick={onBack} className="underline underline-offset-4">
          Back to the board
        </button>
        <div className="mt-4">
          <Empty title="That conversation is not available.">
            It may belong to a different session. Ombuds signs every visitor in
            anonymously, so a search and its threads are only visible to the
            browser that started them.
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-6 py-8">
      <button onClick={onBack} className="text-[16px] underline underline-offset-4">
        Back to the board
      </button>

      <h2 className="mt-4 text-[22px] font-semibold">{thread.facilityName}</h2>
      <p className="mt-1 text-[16px] text-muted">
        {thread.inboxEmail} → {thread.toEmail}
        {thread.deliveryStatus && ` · AgentMail: ${thread.deliveryStatus}`}
      </p>

      {thread.simulated && (
        <p className="mt-3 rounded border border-rule p-3 text-[14px] text-muted">
          This conversation is simulated. We do not send hackathon traffic to
          real, understaffed nursing homes, so the inquiry was routed to an
          inbox we control and answered by a seeded persona
          {thread.persona ? ` (${thread.persona.replace(/_/g, " ")})` : ""}.
          {thread.intendedTo &&
            ` In live mode this would have gone to ${thread.intendedTo}.`}{" "}
          Everything after the reply arrives — reading it, noticing what was
          left out, writing back — is the same code that runs on a real reply.
        </p>
      )}

      {/* The round counter, in words. This is the thing to read the thread
          for: the reply that dodged a question, and then the message the agent
          wrote back on its own. */}
      {thread.rounds > 1 && (
        <p className="mt-3 rounded border border-ink p-3 text-[16px]">
          <span className="font-medium">
            Round {thread.rounds} of {thread.maxRounds}.
          </span>{" "}
          {thread.followUpReason === "low_confidence"
            ? "Their first reply addressed everything but was too vague to plan around, so the agent asked again for a figure — in this thread, on its own."
            : "They left one of the five questions unanswered, so the agent asked again — in this thread, on its own."}{" "}
          One follow-up per facility, and then we stop.
        </p>
      )}

      {thread.nudgeCount > 0 && (
        <p className="mt-3 text-[16px] text-muted">
          They went quiet, so we sent one short note. Only ever one.
        </p>
      )}

      {thread.staleAt !== null && (
        <p className="mt-3 text-[16px] text-muted">
          What they told us here is more than thirty days old. Openings and
          waitlists move.
        </p>
      )}

      {thread.unansweredLabels.length > 0 && (
        <p className="mt-3 text-[16px]">
          Still unanswered:{" "}
          <span className="font-medium">
            {thread.unansweredLabels.join(", ")}
          </span>
        </p>
      )}

      {thread.messages.length === 0 ? (
        <div className="mt-6">
          <Empty title="Nothing has been sent yet.">
            The letter is being drafted for this family and this facility. It
            appears here the moment it goes out.
          </Empty>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {thread.messages.map((m) => (
            <Message key={m.id} message={{ ...m, id: m.id as string }} />
          ))}
        </ul>
      )}
    </section>
  );
}
