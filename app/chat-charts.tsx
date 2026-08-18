"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  AirportMetricsResult,
  CompareResult,
  ExplainScoreResult,
  FlightMixResult,
  RankAirportsResult,
  RankedRow,
} from "../lib/tools/airport-tools";
import type { ChartPayload } from "../lib/tools/chart-payload";
import { EmptyChart, SERIES, axisStyle, tooltipProps } from "./chart-theme";
import { AirportChoiceCards } from "./chat-choice";

/**
 * Charts drawn from tool results inside the chat.
 *
 * THE MODEL DOES NOT DRAW THESE. It chose which tool to call; the tool returned a typed result;
 * this file renders that result verbatim. No value on screen has passed through the language
 * model, which is the same boundary the scoring engine keeps, one layer up. See
 * `lib/tools/chart-payload.ts`.
 *
 * Charts are ADDITIVE. The prose answer stays complete on its own — `must-mention.ts` checks that
 * required context reached the ANSWER TEXT, and a picture cannot discharge that obligation.
 */

/** Below this many points a segment is too narrow to hold its own label legibly. */
const MIN_POINTS_FOR_INLINE_LABEL = 6;

/**
 * How a score was built: one bar, one segment per component, widths summing to the total.
 *
 * A stacked bar rather than four separate bars because the additivity IS the claim — the score is
 * a weighted sum and nothing else, and a reader should be able to see the parts make the whole.
 * `airport-tools.test.ts` asserts these contributions sum to the score, so the picture is provably
 * faithful rather than merely plausible.
 */
export function ScoreContributionChart({ data }: { data: ExplainScoreResult }) {
  const available = data.components.filter((c) => !c.unavailableReason);
  if (available.length === 0) {
    return <EmptyChart note="No scored components available for this airport." />;
  }

  // One row: Recharts stacks across series, so each component becomes its own keyed series.
  const row: Record<string, number | string> = { label: data.iata };
  for (const c of available) row[c.component] = c.pointsContributed;

  const missing = data.components.filter((c) => c.unavailableReason);

  return (
    <figure className="my-3">
      <figcaption className="mb-1 text-xs opacity-70">
        How {data.iata}&apos;s score of {data.score.toFixed(1)} is built — {available.length}{" "}
        components, weighted, within the {data.cohort.replace(/_/g, " ")} cohort
        {data.cohortSize ? ` of ${data.cohortSize}` : ""}.
      </figcaption>

      <ResponsiveContainer width="100%" height={92}>
        <BarChart data={[row]} layout="vertical" margin={{ left: 4, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis
            type="number"
            domain={[0, 100]}
            tick={axisStyle}
            stroke="var(--chart-grid)"
            tickFormatter={(v) => String(Math.round(Number(v)))}
          />
          <YAxis type="category" dataKey="label" width={44} tick={axisStyle} stroke="var(--chart-grid)" />
          <Tooltip
            {...tooltipProps}
            formatter={(value, name) => {
              const c = available.find((x) => x.component === name);
              return [
                `${Number(value).toFixed(1)} pts — ${
                  c?.percentileInCohort === null || c === undefined
                    ? "percentile unavailable"
                    : `${c.percentileInCohort.toFixed(0)}th percentile x ${c.weight}`
                }`,
                c?.plainLabel ?? String(name),
              ];
            }}
          />
          {available.map((c, i) => (
            <Bar
              key={c.component}
              dataKey={c.component}
              stackId="score"
              fill={SERIES[i]}
              /* 2px surface gap between segments, so adjacent fills never touch. */
              stroke="var(--background)"
              strokeWidth={2}
              radius={i === available.length - 1 ? [0, 4, 4, 0] : 0}
            >
              {/* Selective labels: a number on every segment collides at these widths. */}
              <LabelList
                dataKey={c.component}
                position="center"
                fontSize={10}
                fill="var(--background)"
                /* Unannotated param: Recharts types this as a broad union including undefined. */
                formatter={(v) =>
                  Number(v) >= MIN_POINTS_FOR_INLINE_LABEL ? Number(v).toFixed(1) : ""
                }
              />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>

      <ComponentTable components={data.components} score={data.score} />

      {missing.length > 0 && (
        <p className="mt-1 text-xs opacity-60">
          Not scored: {missing.map((c) => c.plainLabel).join(", ")} — weight redistributed across
          the rest.
        </p>
      )}
    </figure>
  );
}

/**
 * The data behind the picture, always available.
 *
 * Three of the light-mode series sit below 3:1 against white, which is permitted only when a chart
 * carries direct labels or a table. This is that table. It is also the accessible reading of the
 * chart and, for a product whose whole argument is auditability, the more honest artifact.
 */
function ComponentTable({
  components,
  score,
}: {
  components: ExplainScoreResult["components"];
  score: number;
}) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs opacity-50 hover:opacity-100">Show data</summary>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="opacity-60">
            <tr>
              <th className="py-1 pr-3 font-normal">Component</th>
              <th className="py-1 pr-3 text-right font-normal">Percentile</th>
              <th className="py-1 pr-3 text-right font-normal">Weight</th>
              <th className="py-1 text-right font-normal">Points</th>
            </tr>
          </thead>
          <tbody>
            {components.map((c, i) => (
              <tr key={c.component} className="border-t border-current/10">
                <td className="py-1 pr-3">
                  <span
                    aria-hidden
                    className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                    style={{ background: c.unavailableReason ? "transparent" : SERIES[i] }}
                  />
                  {c.plainLabel}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {c.percentileInCohort === null ? "—" : c.percentileInCohort.toFixed(0)}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{c.weight}</td>
                <td className="py-1 text-right tabular-nums">
                  {c.unavailableReason ? "—" : c.pointsContributed.toFixed(1)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-current/20 font-semibold">
              <td className="py-1 pr-3">Score</td>
              <td colSpan={2} />
              <td className="py-1 text-right tabular-nums">{score.toFixed(1)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * A ranking, drawn.
 *
 * ONE colour for every bar, deliberately. The analytics dashboard colours its bars individually
 * because each is a different topic — a real categorical identity. Here the bars are one series
 * measured once and sorted, so colouring them separately would encode rank as hue and imply a
 * difference in kind that does not exist. Rank is already carried by position and length.
 */
export function RankingChart({ data }: { data: RankAirportsResult }) {
  if (data.rows.length === 0) return <EmptyChart note="No airports matched that filter." />;

  return (
    <figure className="my-3">
      <figcaption className="mb-1 text-xs opacity-70">
        Top {data.rows.length} of {data.populationSize} by score — {data.weightsUsed}.
      </figcaption>

      <ResponsiveContainer width="100%" height={Math.max(140, data.rows.length * 26)}>
        <BarChart
          data={data.rows}
          layout="vertical"
          margin={{ left: 4, right: 34, top: 4, bottom: 4 }}
        >
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis type="number" domain={[0, 100]} tick={axisStyle} stroke="var(--chart-grid)" />
          <YAxis
            type="category"
            dataKey="iata"
            width={44}
            tick={axisStyle}
            stroke="var(--chart-grid)"
          />
          <Tooltip
            {...tooltipProps}
            formatter={(value, _name, entry) => {
              const r = entry?.payload as RankedRow | undefined;
              return [
                `score ${Number(value).toFixed(1)}${
                  r ? ` — ${Math.round(r.passengers).toLocaleString("en-US")} passengers` : ""
                }`,
                r ? `#${r.rank} ${r.city ?? r.iata}` : "airport",
              ];
            }}
          />
          <Bar dataKey="score" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={14}>
            <LabelList
              dataKey="score"
              position="right"
              fontSize={10}
              fill="currentColor"
              formatter={(v) => Number(v).toFixed(1)}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <SimpleTable
        head={["#", "Airport", "Cohort", "Score", "Passengers"]}
        rows={data.rows.map((r) => [
          String(r.rank),
          r.city ? `${r.iata} — ${r.city}` : r.iata,
          r.cohort.replace(/_/g, " "),
          r.score.toFixed(1),
          Math.round(r.passengers).toLocaleString("en-US"),
        ])}
      />
    </figure>
  );
}

/**
 * A comparison, drawn on score alone.
 *
 * DELIBERATELY NOT a grouped chart across every metric. `ComparisonRow` carries passengers, load
 * factor, delay minutes, taxi time and seats per departure — five incompatible units. Putting them
 * on one axis is meaningless, and putting them on two is the single most common charting mistake
 * there is. Score is the one figure already normalised and comparable, so it is the one that gets
 * a chart; the rest are exact in the table, where their units can be stated.
 *
 * Colour is per airport here — a real categorical identity, unlike the ranking above.
 */
export function ComparisonChart({ data }: { data: CompareResult }) {
  const scored = data.rows.filter((r) => r.score !== null);
  if (scored.length < 2) return <EmptyChart note="Not enough scored airports to compare." />;

  return (
    <figure className="my-3">
      <figcaption className="mb-1 text-xs opacity-70">
        Score comparison
        {data.sameCohort
          ? " — same size cohort, so these are directly comparable."
          : " — DIFFERENT cohorts. A score is a percentile rank within a cohort, so these two numbers do not measure the same thing."}
      </figcaption>

      <ResponsiveContainer width="100%" height={Math.max(110, scored.length * 34)}>
        <BarChart data={scored} layout="vertical" margin={{ left: 4, right: 34, top: 4, bottom: 4 }}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis type="number" domain={[0, 100]} tick={axisStyle} stroke="var(--chart-grid)" />
          <YAxis
            type="category"
            dataKey="iata"
            width={44}
            tick={axisStyle}
            stroke="var(--chart-grid)"
          />
          <Tooltip {...tooltipProps} />
          <Bar dataKey="score" radius={[0, 4, 4, 0]} barSize={16}>
            {scored.map((r, i) => (
              <Cell key={r.iata} fill={SERIES[i % SERIES.length]} />
            ))}
            <LabelList
              dataKey="score"
              position="right"
              fontSize={10}
              fill="currentColor"
              formatter={(v) => Number(v).toFixed(1)}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <SimpleTable
        head={["Airport", "Score", "Passengers", "Load factor", "NAS delay/arr"]}
        rows={data.rows.map((r) => [
          r.city ? `${r.iata} — ${r.city}` : r.iata,
          r.score === null ? "—" : r.score.toFixed(1),
          Math.round(r.passengers).toLocaleString("en-US"),
          r.loadFactorPct === null ? "—" : `${r.loadFactorPct.toFixed(1)}%`,
          r.nasDelayMinPerArrival === null ? "—" : `${r.nasDelayMinPerArrival.toFixed(2)} min`,
        ])}
      />
    </figure>
  );
}

/**
 * Traffic composition: two part-to-whole bars, not one.
 *
 * Distance band and destination country are two different partitions of the same passengers.
 * Stacking all five segments into a single bar would double the total and invite exactly the wrong
 * reading. Two bars, each summing to 100%, keeps the two questions apart.
 *
 * Not a pie: comparing angles is harder than comparing lengths, and stacked bars put both
 * partitions on a shared scale where they can be read against each other.
 */
export function FlightMixChart({ data }: { data: FlightMixResult }) {
  if (data.totalPassengers <= 0) {
    return <EmptyChart note="No scheduled passenger traffic to break down." />;
  }

  return (
    <figure className="my-3">
      <figcaption className="mb-1 text-xs opacity-70">
        {data.iata} traffic mix, {data.year} —{" "}
        {Math.round(data.totalPassengers).toLocaleString("en-US")} scheduled passengers.
      </figcaption>

      <PercentBar
        row={{
          label: "By distance",
          Short: data.haul.shortPct,
          Medium: data.haul.mediumPct,
          Long: data.haul.longPct,
        }}
        keys={["Short", "Medium", "Long"]}
        offset={0}
      />
      <PercentBar
        row={{
          label: "By destination",
          Domestic: 100 - data.internationalPct,
          International: data.internationalPct,
        }}
        keys={["Domestic", "International"]}
        offset={3}
      />

      <SimpleTable
        head={["Segment", "Share", "Passengers"]}
        rows={[
          ["Short haul", `${data.haul.shortPct.toFixed(1)}%`, Math.round(data.haul.shortPassengers).toLocaleString("en-US")],
          ["Medium haul", `${data.haul.mediumPct.toFixed(1)}%`, Math.round(data.haul.mediumPassengers).toLocaleString("en-US")],
          ["Long haul", `${data.haul.longPct.toFixed(1)}%`, Math.round(data.haul.longPassengers).toLocaleString("en-US")],
          ["Domestic", `${(100 - data.internationalPct).toFixed(1)}%`, Math.round(data.domesticPassengers).toLocaleString("en-US")],
          ["International", `${data.internationalPct.toFixed(1)}%`, Math.round(data.internationalPassengers).toLocaleString("en-US")],
        ]}
      />
    </figure>
  );
}

/** One 100%-wide stacked bar. `offset` picks where in the fixed series order this bar starts. */
function PercentBar({
  row,
  keys,
  offset,
}: {
  row: Record<string, number | string>;
  keys: string[];
  offset: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={52}>
      <BarChart data={[row]} layout="vertical" margin={{ left: 4, right: 8, top: 2, bottom: 2 }}>
        <XAxis type="number" domain={[0, 100]} hide />
        <YAxis
          type="category"
          dataKey="label"
          width={92}
          tick={axisStyle}
          stroke="var(--chart-grid)"
        />
        <Tooltip {...tooltipProps} formatter={(v, n) => [`${Number(v).toFixed(1)}%`, String(n)]} />
        {keys.map((k, i) => (
          <Bar
            key={k}
            dataKey={k}
            stackId="mix"
            fill={SERIES[(offset + i) % SERIES.length]}
            stroke="var(--background)"
            strokeWidth={2}
            radius={i === keys.length - 1 ? [0, 4, 4, 0] : 0}
          >
            <LabelList
              dataKey={k}
              position="center"
              fontSize={10}
              fill="var(--background)"
              formatter={(v) => (Number(v) >= 12 ? `${Number(v).toFixed(0)}%` : "")}
            />
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Airport metrics as tiles, NOT as a line chart.
 *
 * The dataset holds three years. A line across three points draws a trend the data cannot support:
 * the eye reads a slope and infers a trajectory from two intervals. Tiles state the level and the
 * change, which is as much as three observations justify, and the full history sits in the table.
 */
export function MetricsTiles({ data }: { data: AirportMetricsResult }) {
  const sorted = [...data.history].sort((a, b) => a.year - b.year);
  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const prior = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const paxDelta =
    latest && prior && prior.passengers > 0
      ? ((latest.passengers - prior.passengers) / prior.passengers) * 100
      : null;

  return (
    <figure className="my-3">
      <figcaption className="mb-1 text-xs opacity-70">
        {data.city ? `${data.iata} — ${data.city}` : data.iata}, {data.year}
        {data.cohort ? ` · ${data.cohort.replace(/_/g, " ")}` : ""}
      </figcaption>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          label="Passengers"
          value={Math.round(data.passengers).toLocaleString("en-US")}
          note={paxDelta === null ? null : `${paxDelta >= 0 ? "+" : ""}${paxDelta.toFixed(1)}% YoY`}
        />
        <Tile
          label="Load factor"
          value={data.loadFactorPct === null ? "—" : `${data.loadFactorPct.toFixed(1)}%`}
          note={null}
        />
        <Tile
          label="NAS delay / arrival"
          value={
            data.nasDelayMinPerArrival === null
              ? "—"
              : `${data.nasDelayMinPerArrival.toFixed(2)} min`
          }
          note={data.nasDelayMinPerArrival === null ? "not measured here" : null}
        />
        <Tile label="Score" value={data.score === null ? "—" : data.score.toFixed(1)} note={null} />
      </div>

      <SimpleTable
        head={["Year", "Passengers", "Seats", "Departures", "Load factor"]}
        rows={sorted.map((h) => [
          String(h.year),
          Math.round(h.passengers).toLocaleString("en-US"),
          Math.round(h.seats).toLocaleString("en-US"),
          Math.round(h.departures).toLocaleString("en-US"),
          h.loadFactorPct === null ? "—" : `${h.loadFactorPct.toFixed(1)}%`,
        ])}
      />
    </figure>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string | null }) {
  return (
    <div className="rounded-lg border border-current/10 px-3 py-2">
      <div className="text-xs opacity-60">{label}</div>
      <div className="text-base tabular-nums">{value}</div>
      {note && <div className="text-xs opacity-50">{note}</div>}
    </div>
  );
}

/** The data behind a chart. Collapsed, but always one click away. */
function SimpleTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs opacity-50 hover:opacity-100">Show data</summary>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="opacity-60">
            <tr>
              {head.map((h, i) => (
                <th key={h} className={`py-1 pr-3 font-normal ${i === 0 ? "" : "text-right"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-current/10">
                {r.map((cell, j) => (
                  <td key={j} className={`py-1 pr-3 ${j === 0 ? "" : "text-right tabular-nums"}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Tool result in, component out.
 *
 * The exhaustive switch lives here rather than in the page so that adding a tool to `ChartPayload`
 * without deciding how it should look is a compile error, not a silently empty turn. That is the
 * whole reason the payload is a discriminated union instead of `unknown`.
 */
export function ChartForPayload({
  payload,
  onAsk,
  disabled,
}: {
  payload: ChartPayload;
  onAsk: (question: string) => void;
  disabled?: boolean;
}) {
  switch (payload.tool) {
    case "explainScore":
      return <ScoreContributionChart data={payload.data} />;
    case "rankAirports":
      return <RankingChart data={payload.data} />;
    case "compareAirports":
      return <ComparisonChart data={payload.data} />;
    case "flightMix":
      return <FlightMixChart data={payload.data} />;
    case "getAirportMetrics":
      return <MetricsTiles data={payload.data} />;
    case "resolveAirport":
      return <AirportChoiceCards data={payload.data} onAsk={onAsk} disabled={disabled} />;
    default: {
      // Exhaustiveness guard: if this stops compiling, a tool gained a payload without a view.
      const unhandled: never = payload;
      return unhandled;
    }
  }
}
