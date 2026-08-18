import type {
	AirportMetricsResult,
	CompareResult,
	ExplainScoreResult,
	FlightMixResult,
	RankAirportsResult,
	ResolveResult,
} from "./airport-tools";
import type { ToolResult } from "./types";

/**
 * The tool output a turn hands to the browser so the interface can draw it.
 *
 * WHY THIS EXISTS. There are two ways to build generative UI and only one of them survives the
 * claim this system is built on -- that the language model computes nothing.
 *
 * The model could emit a chart spec. That is what most demos do, and it would let the model decide
 * what goes into the chart, which is the same thing as letting it invent a number.
 *
 * Instead the model chooses a TOOL, and the client maps that tool to a component which renders the
 * tool's own output verbatim. The model still decides which tool runs -- that is the generative
 * act, and it is the agentic surface that already existed. What it cannot do is decide what a bar
 * is worth. Same boundary as the scoring engine, one layer up.
 *
 * Discriminated by tool name rather than typed `unknown`, so a tool added without deciding its
 * visual treatment is a compile error rather than a silently empty turn.
 */
export type ChartPayload =
	| { tool: "resolveAirport"; data: ResolveResult }
	| { tool: "getAirportMetrics"; data: AirportMetricsResult }
	| { tool: "rankAirports"; data: RankAirportsResult }
	| { tool: "compareAirports"; data: CompareResult }
	| { tool: "explainScore"; data: ExplainScoreResult }
	| { tool: "flightMix"; data: FlightMixResult };

export type ChartToolName = ChartPayload["tool"];

/**
 * How many ranking rows are serialised to the browser.
 *
 * rankAirports will return up to 50 rows. A bar chart that tall is unreadable, and the remainder
 * is transport cost paid for nothing. This caps only what is DRAWN -- the model still receives the
 * full result, so the prose can still speak about the whole ranking.
 */
export const CHART_ROW_CAP = 12;

/**
 * Build the browser payload for one tool call, or undefined when there is nothing to draw.
 *
 * `dispatchTool` erases its return type to `ToolResult<unknown>`, so the cast back to a concrete
 * result type has to happen somewhere. Doing it here, once, keeps every consumer above this file
 * fully typed -- the alternative is `unknown` leaking all the way into the components.
 */
export function payloadFor(name: string, result: ToolResult<unknown>): ChartPayload | undefined {
	// A failure carries no `data`; the trace already renders the error code.
	if (!result.ok) return undefined;

	switch (name) {
		case "resolveAirport":
			return { tool: name, data: result.data as ResolveResult };
		case "getAirportMetrics":
			return { tool: name, data: result.data as AirportMetricsResult };
		case "compareAirports":
			return { tool: name, data: result.data as CompareResult };
		case "explainScore":
			return { tool: name, data: result.data as ExplainScoreResult };
		case "flightMix":
			return { tool: name, data: result.data as FlightMixResult };

		case "rankAirports": {
			const data = result.data as RankAirportsResult;
			return data.rows.length <= CHART_ROW_CAP
				? { tool: name, data }
				: { tool: name, data: { ...data, rows: data.rows.slice(0, CHART_ROW_CAP) } };
		}

		default:
			return undefined;
	}
}
