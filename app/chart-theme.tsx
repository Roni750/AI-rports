"use client";

/**
 * Shared chart chrome for every Recharts surface in the app.
 *
 * Extracted so the analytics dashboard and the chat cannot drift into two visual systems. The
 * colours themselves live in `globals.css` as `--chart-N` custom properties, so light and dark are
 * handled by the same mechanism as the rest of the app rather than by a second theme system living
 * inside a charting library's config.
 *
 * The ORDER of SERIES is not cosmetic — see the note in globals.css. Assign slots in fixed order
 * and never cycle past the end.
 */

export const SERIES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

export const axisStyle = { fontSize: 11, fill: "currentColor", opacity: 0.6 };

/** Shared tooltip chrome, so every chart reads as one component rather than N defaults. */
export const tooltipProps = {
  contentStyle: {
    background: "var(--background)",
    border: "1px solid var(--chart-grid)",
    borderRadius: "0.5rem",
    fontSize: "0.75rem",
    color: "var(--foreground)",
  },
  /*
   * The value row has to be given a colour explicitly.
   *
   * Recharts computes each tooltip row as `color: entry.color || '#000'`. When a bar is coloured
   * through <Cell> rather than the series `fill`, `entry.color` does not resolve and it falls back
   * to hard-coded black — invisible against the dark surface. Setting itemStyle overrides it,
   * because Recharts spreads the caller's itemStyle last.
   *
   * Overriding it is right even where the colour DOES resolve: text wears ink, never the series
   * colour. The swatch beside the label already carries the identity, and series hues are chosen
   * to be legible as fills, not as small text.
   */
  itemStyle: { color: "var(--foreground)" },
  labelStyle: { color: "var(--foreground)", opacity: 0.6 },
  cursor: { fill: "currentColor", opacity: 0.05 },
  /*
   * Lifts the tooltip above any chart that follows it.
   *
   * Recharts gives every `.recharts-wrapper` `position: relative` and no z-index. Positioned
   * siblings paint in DOM order, so a tooltip belonging to one chart is painted OVER by the next
   * chart down — the flight-mix "By distance" tooltip was disappearing behind the "By destination"
   * bar. The tooltip is only tall enough to overlap a neighbour on the short 52px bars, which is
   * why it looked like a bug in one chart rather than a shared default.
   *
   * Fixed here rather than on the one chart that showed it: any two stacked charts would hit it,
   * and a tooltip that can be covered is wrong everywhere. 10 is enough to clear sibling content
   * while staying under the app's own overlays.
   */
  wrapperStyle: { zIndex: 10 },
} as const;

/**
 * The empty state is a component, not a blank box.
 *
 * An empty chart and a broken chart look identical otherwise, and the difference matters most
 * exactly when someone is looking at a chart to find out what went wrong.
 */
export function EmptyChart({ note }: { note: string }) {
  return (
    <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-current/15 text-xs opacity-50">
      {note}
    </div>
  );
}
