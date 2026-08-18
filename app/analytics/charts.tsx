"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Every chart on the dashboard, and the only file in the app that imports Recharts.
 *
 * THE BOUNDARY IS THE POINT. Recharts is client-only, so importing it anywhere in the page tree
 * would force `"use client"` upward and break the thing that makes `page.tsx` simple: it reads the
 * database directly on the server, with no fetch, no loading state and no client data layer.
 * Confining the library to one leaf keeps that property. Panels, tiles and tables above this file
 * stay server components and receive plain serialisable props.
 *
 * Colours come from the `--chart-N` custom properties in `globals.css`, so light and dark are
 * handled by the same mechanism as the rest of the app rather than by a second theme system living
 * inside a charting library's config.
 */

const SERIES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

const axisStyle = { fontSize: 11, fill: "currentColor", opacity: 0.6 };

/** Shared tooltip chrome, so all three charts read as one component rather than three defaults. */
const tooltipProps = {
  contentStyle: {
    background: "var(--background)",
    border: "1px solid var(--chart-grid)",
    borderRadius: "0.5rem",
    fontSize: "0.75rem",
    color: "var(--foreground)",
  },
  cursor: { fill: "currentColor", opacity: 0.05 },
} as const;

export interface TopicBar {
  label: string;
  turns: number;
  share: number;
}

/**
 * Topic distribution — the headline "under an umbrella" view.
 *
 * Horizontal, because topic names are words: a vertical bar chart would either truncate them or
 * rotate them 45 degrees, and neither is readable at ten categories.
 */
export function TopicBars({ data }: { data: TopicBar[] }) {
  const rows = data.filter((d) => d.turns > 0);
  if (rows.length === 0) return <EmptyChart note="No labelled turns in this window." />;

  return (
    <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 34)}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis type="number" tick={axisStyle} stroke="var(--chart-grid)" allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="label"
          width={160}
          tick={axisStyle}
          stroke="var(--chart-grid)"
        />
        {/* Params are left uannotated: Recharts types `value` as a broad union including
            undefined, so annotating it `number` fails to satisfy its Formatter signature. */}
        <Tooltip
          {...tooltipProps}
          formatter={(value, _name, entry) => [
            `${Number(value)} turns (${(((entry?.payload as TopicBar)?.share ?? 0) * 100).toFixed(1)}%)`,
            "volume",
          ]}
        />
        <Bar dataKey="turns" radius={[0, 4, 4, 0]}>
          {rows.map((row, i) => (
            <Cell key={row.label} fill={SERIES[i % SERIES.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface VolumePoint {
  day: string;
  turns: number;
  sessions: number;
}

export function VolumeArea({ data }: { data: VolumePoint[] }) {
  if (data.length === 0) return <EmptyChart note="No turns in this window." />;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 4 }}>
        <CartesianGrid stroke="var(--chart-grid)" />
        <XAxis dataKey="day" tick={axisStyle} stroke="var(--chart-grid)" minTickGap={24} />
        <YAxis tick={axisStyle} stroke="var(--chart-grid)" allowDecimals={false} width={32} />
        <Tooltip {...tooltipProps} />
        <Area
          type="monotone"
          dataKey="turns"
          stroke="var(--chart-1)"
          fill="var(--chart-1)"
          fillOpacity={0.18}
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="sessions"
          stroke="var(--chart-2)"
          fill="var(--chart-2)"
          fillOpacity={0.12}
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface ToolBar {
  toolName: string;
  calls: number;
  meanDurationMs: number;
}

/** Tool usage, coloured by call volume rather than by name — the slow one should stand out. */
export function ToolBars({ data }: { data: ToolBar[] }) {
  if (data.length === 0) return <EmptyChart note="No tool calls in this window." />;

  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis type="number" tick={axisStyle} stroke="var(--chart-grid)" allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="toolName"
          width={140}
          tick={axisStyle}
          stroke="var(--chart-grid)"
        />
        <Tooltip
          {...tooltipProps}
          formatter={(value, _name, entry) => [
            `${Number(value)} calls, mean ${Math.round((entry?.payload as ToolBar)?.meanDurationMs ?? 0)}ms`,
            "usage",
          ]}
        />
        <Bar dataKey="calls" radius={[0, 4, 4, 0]}>
          {data.map((row, i) => (
            <Cell key={row.toolName} fill={SERIES[i % SERIES.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * The empty state is a component, not a blank box.
 *
 * An empty chart and a broken chart look identical otherwise, and the difference matters most
 * exactly when someone is looking at a dashboard to find out what went wrong.
 */
function EmptyChart({ note }: { note: string }) {
  return (
    <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-current/15 text-xs opacity-50">
      {note}
    </div>
  );
}
