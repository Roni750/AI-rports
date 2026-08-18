"use client";

import type { ResolveResult } from "../lib/tools/airport-tools";

/**
 * The ambiguity a place name carries, offered as a choice instead of a paragraph.
 *
 * "Compare LA and Santa Ana" is ambiguous twice over: LA could mean LAX alone or the whole basin,
 * and Santa Ana sits inside that basin. The resolver already detects this and returns both
 * readings rather than silently picking one — but until now the only way to answer was to type a
 * clarification in prose and hope the model matched it to the right reading.
 *
 * These are the same interpretations the resolver produced, made clickable. The user picks a
 * reading; the reading is restated as a question; the agent answers it. Nothing here decides
 * anything on the user's behalf, which is the whole point of surfacing the ambiguity.
 */
export function AirportChoiceCards({
  data,
  onAsk,
  disabled,
}: {
  data: ResolveResult;
  onAsk: (question: string) => void;
  disabled?: boolean;
}) {
  if (data.kind !== "ambiguous" || !data.interpretations?.length) return null;

  return (
    <div className="my-2 flex flex-col gap-2">
      <p className="text-xs opacity-70">Which did you mean?</p>

      <div className="flex flex-wrap gap-2">
        {data.interpretations.map((option) => (
          <button
            key={option.label}
            type="button"
            disabled={disabled}
            onClick={() => onAsk(questionFor(option))}
            className="max-w-full rounded-lg border border-current/15 px-3 py-2 text-left text-sm transition hover:border-current/40 hover:bg-current/5 disabled:opacity-50"
          >
            <span className="block font-medium">{option.label}</span>
            <span className="block text-xs opacity-60">
              {option.airports.join(", ")} — {option.description}
            </span>
          </button>
        ))}
      </div>

      {data.notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs opacity-60">
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Turn a chosen reading back into a question.
 *
 * The airport codes are named explicitly so the follow-up is unambiguous on its own terms — the
 * next turn should not have to re-resolve the same phrase and risk landing somewhere else.
 */
function questionFor(option: { label: string; airports: string[] }): string {
  return `${option.label} — use ${option.airports.join(", ")}.`;
}
