"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { costUsd, formatUsd } from "../lib/analytics/pricing";
import type { ChartPayload } from "../lib/tools/chart-payload";

/**
 * Charts load on demand.
 *
 * Recharts and its d3 dependencies are heavy, and this is the landing page — most first visits
 * never reach a tool call, let alone one with a visual treatment. Keeping the chart leaf out of the
 * initial bundle costs one render frame the first time a chart appears and saves every visitor who
 * never sees one.
 */
const ChartForPayload = dynamic(
  () => import("./chat-charts").then((m) => m.ChartForPayload),
  { ssr: false, loading: () => <div className="my-3 h-24" aria-hidden /> },
);

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
  /** The tool's own result. Present when the tool has a visual treatment and the call succeeded. */
  payload?: ChartPayload;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  trace?: ToolTraceEntry[];
  model?: string;
  truncated?: boolean;
  usage?: { promptTokens: number | null; completionTokens: number | null };
  timing?: { totalMs: number };
}

/**
 * The conversation's analytics id.
 *
 * Held in `sessionStorage`, which is scoped to a single tab — exactly the boundary of one
 * conversation. A cookie would work too, and would also make this a stateful endpoint and raise a
 * consent question that a screening demo has no need to answer.
 *
 * MINTED BY THE SERVER, not here. The id ends up in `turn_id` and the turn write is an upsert, so
 * a client that could choose its own id could name — and therefore overwrite — another
 * conversation's recorded turn. The server now returns a signed token on every response and
 * ignores anything it did not sign; this side just holds on to whatever it was given. The first
 * request of a session sends nothing and is answered with a fresh token.
 *
 * Read inside the send handler rather than in a `useState` initialiser: the initialiser runs
 * during server rendering, where `sessionStorage` is unavailable, and a value that differed
 * between server and client would produce a hydration mismatch.
 */
const SESSION_KEY = "aii.session";

function storedSessionToken(): string | undefined {
  return sessionStorage.getItem(SESSION_KEY) ?? undefined;
}

function rememberSessionToken(token: unknown): void {
  if (typeof token === "string" && token !== "") sessionStorage.setItem(SESSION_KEY, token);
}

/**
 * The tokens/cost/latency suffix for the trace footer.
 *
 * Returns nothing rather than a placeholder when the numbers are unavailable — a turn whose
 * provider omitted usage should say less, not guess.
 */
function describeCost(turn: Turn): string {
  const parts: string[] = [];
  const tokens = (turn.usage?.promptTokens ?? 0) + (turn.usage?.completionTokens ?? 0);
  if (tokens > 0) parts.push(`${tokens.toLocaleString()} tokens`);

  const cost = turn.model
    ? costUsd(turn.model, turn.usage?.promptTokens ?? null, turn.usage?.completionTokens ?? null)
    : null;
  if (cost !== null) parts.push(formatUsd(cost));

  if (turn.timing) parts.push(`${(turn.timing.totalMs / 1000).toFixed(1)}s`);

  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
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
    // `scrollIntoView` takes its behaviour from this argument, not from the stylesheet, so the
    // reduced-motion rule in globals.css cannot reach it. Asked directly instead.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "end" });
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
          sessionId: storedSessionToken(),
        }),
      });
      const data = await res.json();
      // Stored before the status check: the error paths return a token too, so a session survives
      // a failed turn instead of splitting the conversation in the analytics table.
      rememberSessionToken(data.sessionId);

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
          usage: data.usage,
          timing: data.timing,
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
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">Airport Investment Intelligence</h1>
          <Link
            href="/analytics"
            className="rounded text-sm underline decoration-dotted opacity-70 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current/50"
          >
            Analytics →
          </Link>
        </div>
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
              className="rounded-lg border border-current/15 px-3 py-2 text-left text-sm transition hover:border-current/40 hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current/50 disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </section>
      )}

      <div className="flex flex-1 flex-col gap-4">
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div
              key={i}
              // A pasted airport list or a long unspaced string would otherwise widen the bubble
              // past the column and put a horizontal scrollbar on the whole page.
              className="max-w-full self-end overflow-hidden rounded-2xl bg-current/10 px-4 py-2 text-sm break-words"
            >
              {turn.content}
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-2">
              {/*
                Drawn from the tool payloads, above the narration they belong to. Nothing here was
                produced by the model: it chose the tool, the tool returned typed data, and the
                component renders that data. The prose below stays complete on its own.
              */}
              {turn.trace?.map((t, j) =>
                t.payload ? (
                  <ChartForPayload key={j} payload={t.payload} onAsk={send} disabled={busy} />
                ) : null,
              )}

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
                    className="rounded underline decoration-dotted opacity-60 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current/50"
                  >
                    {openTrace === i ? "Hide" : "Show"} data sources ({turn.trace.length}{" "}
                    {turn.trace.length === 1 ? "tool call" : "tool calls"})
                  </button>

                  {openTrace === i && (
                    <ul className="mt-2 flex flex-col gap-1 rounded-lg border border-current/10 p-2 font-mono">
                      {turn.trace.map((t, j) => (
                        <li key={j} className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className={t.ok ? "text-emerald-600 dark:text-emerald-500" : "text-red-600 dark:text-red-500"}>
                              {t.ok ? "ok" : t.errorCode ?? "error"}
                            </span>
                            <span className="font-semibold">{t.name}</span>
                            {/* Serialised arguments have no spaces to wrap at, so they need
                                break-all and a min-w-0 flex parent or they push the row wide. */}
                            <span className="min-w-0 break-all opacity-60">
                              {Object.keys(t.arguments).length > 0
                                ? JSON.stringify(t.arguments)
                                : "{}"}
                            </span>
                            <span className="tabular-nums whitespace-nowrap opacity-40">
                              {t.durationMs}&nbsp;ms
                            </span>
                          </div>

                          {/*
                            The raw payload the charts will be drawn from. Visible here on purpose:
                            it is the same object the components receive, so "does the chart match
                            the answer" is checkable rather than a matter of trust.
                          */}
                          {t.payload && (
                            <details className="ml-4">
                              <summary className="cursor-pointer opacity-50 hover:opacity-100">
                                payload
                              </summary>
                              <pre className="mt-1 max-h-64 overflow-auto rounded border border-current/10 p-2 text-[10px] leading-relaxed opacity-70">
                                {JSON.stringify(t.payload.data, null, 2)}
                              </pre>
                            </details>
                          )}
                        </li>
                      ))}
                      {turn.model && (
                        <li className="mt-1 border-t border-current/10 pt-1 opacity-50">
                          model: {turn.model}
                          {/*
                            Cost belongs next to the trace, not only on the analytics page. A
                            number you have to navigate to is a number nobody looks at, and "what
                            does one answer cost" is the question this whole layer exists to make
                            answerable.
                          */}
                          {describeCost(turn)}
                          {" "}— every figure above came from these calls, not from the model
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
          className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-current/50 focus-visible:ring-2 focus-visible:ring-current/25 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ""}
          className="rounded-lg border border-current/20 px-4 py-2 text-sm font-medium transition hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current/50 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </main>
  );
}
