import Link from "next/link";
import { connection } from "next/server";

import { PRICES_CHECKED_ON } from "../../lib/analytics/pricing";
import {
  classifierHealth,
  formatUsd,
  needsReview,
  overview,
  recentSessions,
  reliability,
  toolUsage,
  topicDistribution,
  volumeByDay,
  type AnalyticsEnvelope,
  type AnalyticsQuery,
} from "../../lib/analytics/queries";
import { analyticsStatus } from "../../lib/analytics/store";
import { TopicBars, ToolBars, VolumeArea } from "./charts";

/**
 * Conversation analytics.
 *
 * A server component that reads the database directly. No API route, no client fetch, no loading
 * state — the page is rendered once the data is in hand. Recharts is the only thing that has to run
 * on the client, and it is quarantined in `charts.tsx` so that constraint does not spread.
 *
 * Node runtime because the store uses libSQL. `connection()` marks the page as request-time: it
 * reads a database that changes between requests, so prerendering it would serve a snapshot from
 * build time. `dynamic = "force-dynamic"` would also work today, but `connection()` is the Next 16
 * idiom and survives `cacheComponents` being enabled later.
 */
export const runtime = "nodejs";

const WINDOWS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "All time", days: 3650 },
];

const ORIGINS = [
  { label: "All traffic", value: "all" },
  { label: "Real only", value: "live" },
];

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  await connection();

  const params = await searchParams;
  const days = Number(first(params.days) ?? 30);
  const origin = (first(params.origin) ?? "all") as NonNullable<AnalyticsQuery["origin"]>;

  // The window is expressed in days and resolved to timestamps inside the query layer. Reading the
  // clock during render is impure — two calls in one render could land either side of a boundary.
  const query: AnalyticsQuery = { days, origin };

  // Recorded prompts are user content. When ANALYTICS_TOKEN is set the dashboard requires it,
  // which is what makes a public deployment defensible; left unset, the page is open so local
  // development needs no ceremony. Not authentication — a shared secret in a query string is a
  // gate, not an identity — and DESIGN.md says so rather than implying otherwise.
  const requiredToken = process.env.ANALYTICS_TOKEN;
  if (requiredToken && first(params.token) !== requiredToken) {
    return (
      <Shell days={days} origin={origin}>
        <div role="alert" className="rounded-lg border border-current/20 px-4 py-3 text-sm">
          <p className="font-medium">This dashboard is gated.</p>
          <p className="mt-1 opacity-70">
            It shows recorded user prompts, so it is not published openly. Append{" "}
            <code className="font-mono">?token=…</code> with the value of ANALYTICS_TOKEN.
          </p>
        </div>
      </Shell>
    );
  }

  const status = await analyticsStatus();
  if (!status.enabled) {
    return (
      <Shell days={days} origin={origin}>
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm">
          <p className="font-medium">Analytics storage is unavailable.</p>
          {/* Naming the reason matters: "no data yet" and "the database is unreachable" render
              identically in a chart and mean entirely different things. */}
          <p className="mt-1 opacity-70">{status.reason}</p>
        </div>
      </Shell>
    );
  }

  const [kpis, topics, volume, health, tools, quality, review, sessions] = await Promise.all([
    overview(query),
    topicDistribution(query),
    volumeByDay(query),
    classifierHealth(query),
    toolUsage(query),
    reliability(query),
    needsReview(query),
    recentSessions(query),
  ]);

  return (
    <Shell days={days} origin={origin}>
      {kpis.seededShare > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <p className="font-medium">This view includes seeded traffic.</p>
          <p className="mt-1 opacity-80">
            {(kpis.seededShare * 100).toFixed(0)}% of turns in this window were replayed from a
            scripted corpus rather than asked by a user. Tool calls, tokens and latencies are real
            measurements; only the questions were scripted.{" "}
            <Link href="/analytics?origin=live" className="underline decoration-dotted">
              Show real traffic only
            </Link>
            .
          </p>
        </div>
      )}

      {/* ------------- 1. the headline */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Turns" value={kpis.data.turns.toLocaleString()} />
        <Stat label="Sessions" value={kpis.data.sessions.toLocaleString()} />
        <Stat label="Turns / session" value={kpis.data.turnsPerSession.toFixed(1)} />
        <Stat label="Median latency" value={`${(kpis.data.p50TotalMs / 1000).toFixed(1)}s`} />
        <Stat label="p95 latency" value={`${(kpis.data.p95TotalMs / 1000).toFixed(1)}s`} />
        <Stat
          label="Mean tokens / turn"
          value={kpis.data.meanTokensPerTurn === null ? "—" : Math.round(kpis.data.meanTokensPerTurn).toLocaleString()}
        />
        {/* The figure this whole layer exists to make sayable. */}
        <Stat label="Cost / interaction" value={formatUsd(kpis.data.meanCostUsd)} emphasis />
        <Stat label="Total spend" value={formatUsd(kpis.data.totalCostUsd)} />
      </section>
      <Caveats envelope={kpis} />

      {/* ------------- 2. the umbrella */}
      <Panel
        title="Topics"
        subtitle="Every user prompt grouped under one umbrella. Unclassified is shown, not hidden."
        envelope={topics}
      >
        <TopicBars
          data={topics.data.map((t) => ({ label: t.label, turns: t.turns, share: t.share }))}
        />
        <table className="mt-4 w-full text-xs">
          <thead className="opacity-60">
            <tr>
              <Th>Topic</Th>
              <Th align="right">Turns</Th>
              <Th align="right">Share</Th>
              <Th align="right">Errors</Th>
              <Th align="right">Mean cost</Th>
              <Th align="right">Labelled by model</Th>
            </tr>
          </thead>
          <tbody>
            {topics.data
              .filter((t) => t.turns > 0)
              .map((t) => (
                <tr key={t.topicId} className="border-t border-current/10">
                  <Td>{t.label}</Td>
                  <Td align="right">{t.turns}</Td>
                  <Td align="right">{(t.share * 100).toFixed(1)}%</Td>
                  <Td align="right">{(t.errorRate * 100).toFixed(0)}%</Td>
                  <Td align="right">{formatUsd(t.meanCostUsd)}</Td>
                  <Td align="right">{(t.llmShare * 100).toFixed(0)}%</Td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>

      {/* ------------- 3. volume */}
      <Panel
        title="Volume"
        subtitle="Turns and sessions per day. The gap between them is how often people follow up."
        envelope={volume}
      >
        <VolumeArea data={volume.data} />
      </Panel>

      {/* ------------- 4. reliability */}
      <Panel
        title="Reliability"
        subtitle="Which step degrades, and what per-step reliability implies end to end."
        envelope={quality}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Answered" value={pct(quality.data.answeredRate)} />
          <Stat label="Truncated" value={pct(quality.data.truncationRate)} />
          <Stat label="Errored" value={pct(quality.data.errorRate)} />
          <Stat label="Tool call success" value={pct(quality.data.toolCallSuccessRate)} />
          <Stat label="Tool calls / turn" value={quality.data.meanToolCallsPerTurn.toFixed(1)} />
          <Stat label="Replied with no tool" value={pct(quality.data.zeroToolAnswerRate)} />
        </div>
        {/*
          This number is easy to misread as an invariant breach, so it is annotated rather than
          left bare. Checking the seeded corpus: the zero-tool replies were clarification requests
          ("which region?"), refusals of out-of-scope asks, and methodology answers that come from
          the system prompt — all correct. Distinguishing those from a fabricated answer needs a
          numeric-fidelity check, which is listed as future work rather than implied here.
        */}
        <p className="mt-3 text-xs opacity-60">
          A reply with no tool call is not necessarily a fabricated one: clarification requests,
          refusals of out-of-scope questions, and methodology answers all legitimately use no tool.
          Telling those apart from an invented figure needs a numeric-fidelity check — asserting
          every number in an answer appears in a tool result — which is not built yet.
        </p>
        {quality.data.compounding && (
          // Generated from this window's own numbers rather than asserted as a general principle.
          <p className="mt-4 rounded-lg border border-current/10 bg-current/5 px-3 py-2 text-xs leading-relaxed">
            {quality.data.compounding}
          </p>
        )}
      </Panel>

      {/* ------------- 5. tools */}
      <Panel
        title="Tool usage"
        subtitle="Which tools the model actually reaches for, and what each costs in time."
        envelope={tools}
      >
        <ToolBars data={tools.data} />
        <table className="mt-4 w-full text-xs">
          <thead className="opacity-60">
            <tr>
              <Th>Tool</Th>
              <Th align="right">Calls</Th>
              <Th align="right">Failure rate</Th>
              <Th align="right">Mean</Th>
              <Th align="right">Slowest</Th>
            </tr>
          </thead>
          <tbody>
            {tools.data.map((t) => (
              <tr key={t.toolName} className="border-t border-current/10">
                <Td>{t.toolName}</Td>
                <Td align="right">{t.calls}</Td>
                <Td align="right">{(t.failureRate * 100).toFixed(0)}%</Td>
                <Td align="right">{Math.round(t.meanDurationMs)}ms</Td>
                <Td align="right">{Math.round(t.maxDurationMs)}ms</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* ------------- 6. the classifier, reporting on itself */}
      <Panel
        title="Classifier health"
        subtitle="How labels were produced, and what producing them cost."
        envelope={health}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {health.data.byStage.map((s) => (
            <Stat key={s.stage} label={`${s.stage} labels`} value={`${s.turns} (${pct(s.share)})`} />
          ))}
          <Stat label="Unlabelled" value={String(health.data.unlabelledTurns)} />
          <Stat label="Classification spend" value={formatUsd(health.data.classificationCostUsd)} emphasis />
        </div>
        <p className="mt-3 text-xs opacity-60">
          Active version <code className="font-mono">{health.data.activeVersion}</code>. Labels are
          never overwritten — a new version writes new rows, so two classifiers can be compared over
          identical traffic. Prices checked {PRICES_CHECKED_ON}; unpriced models report no cost
          rather than a guess.
        </p>
      </Panel>

      {/* ------------- 7. the loop back to the eval */}
      <Panel
        title="Needs review"
        subtitle="Lowest-confidence prompts. These are the next gold-set entries, not a backlog."
        envelope={review}
      >
        {review.data.length === 0 ? (
          <p className="text-xs opacity-60">Nothing below the confidence threshold in this window.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="opacity-60">
              <tr>
                <Th>Prompt</Th>
                <Th>Assigned</Th>
                <Th align="right">Confidence</Th>
                <Th>Stage</Th>
              </tr>
            </thead>
            <tbody>
              {review.data.map((row) => (
                <tr key={row.turnId} className="border-t border-current/10">
                  <Td>{row.prompt.slice(0, 80)}</Td>
                  <Td>{row.topicId}</Td>
                  <Td align="right">{row.confidence.toFixed(2)}</Td>
                  <Td>{row.stage}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {/* ------------- 8. sessions */}
      <Panel title="Recent sessions" subtitle="One row per conversation." envelope={sessions}>
        <table className="w-full text-xs">
          <thead className="opacity-60">
            <tr>
              <Th>Started</Th>
              <Th>Origin</Th>
              <Th align="right">Turns</Th>
              <Th>Topics</Th>
              <Th align="right">Cost</Th>
            </tr>
          </thead>
          <tbody>
            {sessions.data.map((s) => (
              <tr key={s.sessionId} className="border-t border-current/10">
                <Td>{s.startedAt.replace("T", " ").slice(0, 16)}</Td>
                <Td>
                  <span className="rounded border border-current/20 px-1.5 py-0.5 text-[0.65rem] uppercase opacity-70">
                    {s.origin}
                  </span>
                </Td>
                <Td align="right">{s.turns}</Td>
                <Td>{s.topics.join(", ")}</Td>
                <Td align="right">{formatUsd(s.totalCostUsd)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Shell>
  );
}

// ------------- layout and primitives
//
// Server components, all of them. They exist to keep the page readable, not because anything here
// needs interactivity.

function Shell({
  children,
  days,
  origin,
}: {
  children: React.ReactNode;
  days: number;
  origin: string;
}) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6">
      <header className="border-b border-current/10 pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">Conversation analytics</h1>
          <Link href="/" className="text-sm underline decoration-dotted opacity-70 hover:opacity-100">
            ← Back to the agent
          </Link>
        </div>
        <p className="mt-1 text-sm opacity-70">
          What people ask this agent, what it costs to answer, and where it degrades.
        </p>

        <nav className="mt-3 flex flex-wrap gap-2 text-xs">
          {WINDOWS.map((w) => (
            <Link
              key={w.days}
              href={`/analytics?days=${w.days}&origin=${origin}`}
              className={chip(days === w.days)}
            >
              {w.label}
            </Link>
          ))}
          <span className="mx-1 opacity-30">|</span>
          {ORIGINS.map((o) => (
            <Link
              key={o.value}
              href={`/analytics?days=${days}&origin=${o.value}`}
              className={chip(origin === o.value)}
            >
              {o.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </main>
  );
}

function chip(active: boolean): string {
  return active
    ? "rounded-lg border border-current/40 bg-current/10 px-2.5 py-1"
    : "rounded-lg border border-current/15 px-2.5 py-1 transition hover:border-current/40 hover:bg-current/5";
}

function Panel({
  title,
  subtitle,
  envelope,
  children,
}: {
  title: string;
  subtitle: string;
  envelope: AnalyticsEnvelope;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs opacity-60">{subtitle}</p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-current/10 p-3">{children}</div>
      <Caveats envelope={envelope} />
    </section>
  );
}

/**
 * Caveats are rendered wherever the data is, never collected into a footnote.
 *
 * The whole reason the query layer generates them is so a reader cannot receive a number without
 * the reason to doubt it. Putting them somewhere else on the page would undo that.
 */
function Caveats({ envelope }: { envelope: AnalyticsEnvelope }) {
  if (envelope.caveats.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs opacity-60">
      {envelope.caveats.map((c) => (
        <li key={c}>
          <span className="mr-1 opacity-60">n={envelope.sampleSize}</span>
          {c}
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        emphasis ? "border-current/30 bg-current/5" : "border-current/10"
      }`}
    >
      <div className="text-xs opacity-60">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th className={`pb-1 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <td className={`py-1 ${align === "right" ? "text-right tabular-nums" : "text-left"}`}>
      {children}
    </td>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
