"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Chat interface for the airport investment agent.
 *
 * The tool trace is shown rather than hidden. It is the visible proof of the architecture: every
 * figure in an answer came from a named tool call, so a reader can see the model routed and
 * narrated rather than invented.
 */

interface ToolTraceEntry {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  trace?: ToolTraceEntry[];
  model?: string;
  truncated?: boolean;
}

/** The brief's four questions, each of which exercises a different capability. */
const EXAMPLES = [
  "Which airports in New England are strong candidates for terminal expansion?",
  "Compare LA and Santa Ana airport congestion levels.",
  "What is the percentage of long haul flights out of Anchorage airport?",
  "What is the unmet flight demand in SFO airport and why?",
];

export default function Page() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [openTrace, setOpenTrace] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    setError(null);
    setInput("");
    const nextTurns: Turn[] = [...turns, { role: "user", content: question }];
    setTurns(nextTurns);
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextTurns.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError({ message: data.error ?? `Request failed (${res.status})`, hint: data.hint });
        return;
      }

      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply,
          trace: data.trace,
          model: data.model,
          truncated: data.truncated,
        },
      ]);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "Network request failed.",
        hint: "Is the dev server still running?",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6">
      <header className="border-b border-current/10 pb-4">
        <h1 className="text-lg font-semibold">Airport Investment Intelligence</h1>
        <p className="mt-1 text-sm opacity-70">
          Screens US airports for expansion opportunity using BTS traffic and delay data
          (2019, 2023, 2024). Measures demand-side opportunity, not profitability.
        </p>
      </header>

      {turns.length === 0 && (
        <section aria-label="Example questions" className="flex flex-col gap-2">
          <p className="text-sm opacity-60">Try one of these:</p>
          {EXAMPLES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => send(q)}
              disabled={busy}
              className="rounded-lg border border-current/15 px-3 py-2 text-left text-sm transition hover:border-current/40 hover:bg-current/5 disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </section>
      )}

      <div className="flex flex-1 flex-col gap-4">
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="self-end rounded-2xl bg-current/10 px-4 py-2 text-sm">
              {turn.content}
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-2">
              <div className="answer text-sm leading-relaxed">
                <Markdown remarkPlugins={[remarkGfm]}>{turn.content}</Markdown>
              </div>

              {turn.truncated && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Reached the step limit — this answer may be incomplete.
                </p>
              )}

              {turn.trace && turn.trace.length > 0 && (
                <div className="text-xs">
                  <button
                    type="button"
                    onClick={() => setOpenTrace(openTrace === i ? null : i)}
                    className="opacity-60 underline decoration-dotted hover:opacity-100"
                  >
                    {openTrace === i ? "Hide" : "Show"} data sources ({turn.trace.length}{" "}
                    {turn.trace.length === 1 ? "tool call" : "tool calls"})
                  </button>

                  {openTrace === i && (
                    <ul className="mt-2 flex flex-col gap-1 rounded-lg border border-current/10 p-2 font-mono">
                      {turn.trace.map((t, j) => (
                        <li key={j} className="flex flex-wrap items-baseline gap-2">
                          <span className={t.ok ? "text-emerald-600 dark:text-emerald-500" : "text-red-600 dark:text-red-500"}>
                            {t.ok ? "ok" : t.errorCode ?? "error"}
                          </span>
                          <span className="font-semibold">{t.name}</span>
                          <span className="opacity-60">
                            {Object.keys(t.arguments).length > 0
                              ? JSON.stringify(t.arguments)
                              : "{}"}
                          </span>
                          <span className="opacity-40">{t.durationMs}ms</span>
                        </li>
                      ))}
                      {turn.model && (
                        <li className="mt-1 border-t border-current/10 pt-1 opacity-50">
                          model: {turn.model} — every figure above came from these calls, not from
                          the model
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ),
        )}

        {/*
          Rendered unconditionally, with only its text changing.

          A live region must already exist in the DOM before its content changes, or screen
          readers can miss the announcement entirely — mounting the element and its text in the
          same instant is the common way to get a status region that silently announces nothing.
          https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/status_role
        */}
        <p className="text-sm opacity-60" role="status" aria-atomic="true">
          {busy ? "Querying the dataset…" : ""}
        </p>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm"
          >
            <p className="font-medium">{error.message}</p>
            {error.hint && <p className="mt-1 opacity-70">{error.hint}</p>}
          </div>
        )}

        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="sticky bottom-0 flex gap-2 border-t border-current/10 bg-[var(--background)] pt-3"
      >
        <label htmlFor="question" className="sr-only">
          Ask about an airport
        </label>
        <input
          id="question"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about an airport, a region, or a comparison…"
          disabled={busy}
          autoComplete="off"
          className="flex-1 rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm outline-none focus:border-current/50 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ""}
          className="rounded-lg border border-current/20 px-4 py-2 text-sm font-medium transition hover:bg-current/10 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </main>
  );
}
