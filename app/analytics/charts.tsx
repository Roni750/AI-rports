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

import { EmptyChart, SERIES, axisStyle, tooltipProps } from "../chart-theme";

/**
 * Every chart on the dashboard, and the only file on THIS route that imports Recharts.
 *
 * THE BOUNDARY IS THE POINT. Recharts is client-only, so importing it anywhere in the page tree
 * would force `"use client"` upward and break the thing that makes `page.tsx` simple: it reads the
 * database directly on the server, with no fetch, no loading state and no client data layer.
 * Confining the library to one leaf keeps that property. Panels, tiles and tables above this file
 * stay server components and receive plain serialisable props.
 *
 * The chat has its own leaf, `app/chat-charts.tsx`, under the same rule. Chrome common to both —
 * the series order, axis and tooltip styling, the empty state — lives in `app/chart-theme.tsx` so
 * the two surfaces cannot drift into separate visual systems.
 */

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

export interface AirportBar {
  code: string;
  label: string | null;
  turns: number;
  promptTurns: number;
  toolTurns: number;
}

/**
 * Which airports people ask about.
 *
 * ONE BAR PER AIRPORT, showing distinct turns — deliberately not a stack of "named by the user"
 * and "resolved by the agent". Those two overlap: naming ANC in the prompt and passing it to a
 * tool is one turn with both counts set, and being both is the normal case, so stacking them
 * would inflate nearly every bar to roughly double its true height. The split is real and worth
 * seeing, so it lives in the table below where the overlap can be stated rather than drawn.
 */
export function AirportBars({ data }: { data: AirportBar[] }) {
  const rows = data.slice(0, 12);
  if (rows.length === 0) return <EmptyChart note="No airports named in this window." />;

  return (
    <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 30)}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis type="number" tick={axisStyle} stroke="var(--chart-grid)" allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="code"
          width={56}
          tick={axisStyle}
          stroke="var(--chart-grid)"
        />
        <Tooltip
          {...tooltipProps}
          formatter={(value, _name, entry) => {
            const row = entry?.payload as AirportBar | undefined;
            return [
              `${Number(value)} turns — named by the user in ${row?.promptTurns ?? 0}, ` +
                `resolved by the agent in ${row?.toolTurns ?? 0}`,
              "asked about",
            ];
          }}
          labelFormatter={(code) => {
            const row = rows.find((r) => r.code === code);
            return row?.label ? `${code} — ${row.label}` : String(code);
          }}
        />
        <Bar dataKey="turns" fill={SERIES[0]} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
