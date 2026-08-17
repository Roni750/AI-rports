import {
  compareAirports,
  explainScore,
  flightMix,
  getAirportMetrics,
  rankAirports,
  resolveAirport,
} from "../tools/airport-tools";
import { fail, type ToolResult } from "../tools/types";

/**
 * Tool definitions exposed to the model, and the dispatcher that runs them.
 *
 * Schemas are OpenAI-function-calling shaped, which is what Groq's API accepts.
 *
 * The dispatcher validates every parameter before touching the data layer. The model is an
 * unreliable caller: it will invent enum values, pass strings where numbers belong, and omit
 * required fields. Each of those must come back as a structured error the model can recover from,
 * never as a thrown exception that kills the turn.
 */

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const COHORTS = ["large_hub", "medium_hub", "small_hub", "non_hub"] as const;
const METROS = [
  "los_angeles",
  "new_york",
  "san_francisco_bay",
  "washington_dc",
  "chicago",
  "dallas",
  "houston",
  "miami",
  "boston",
] as const;

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "resolveAirport",
      // Descriptions are kept to the trigger condition plus anything the model cannot infer from
      // the result shape. The prose that explained *why* each rule exists lived here at ~440 chars
      // per tool and was re-sent on every call; it now lives in the code comments instead.
      description:
        "Turn an airport name, city, or code into airports. Call first when a place is named " +
        "informally ('LA', 'the Bay Area'). Returns kind='ambiguous' with the possible readings " +
        "when a name could mean one airport or a whole metro — ask which was meant. Also reports " +
        "metro membership.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Airport name, city, 3-letter IATA code, or 2-letter US state code.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAirportMetrics",
      description:
        "All figures for one airport: passengers, seats, departures, load factor, aircraft size, " +
        "international and long-haul shares, freight, delay figures, and multi-year history.",
      parameters: {
        type: "object",
        properties: {
          iata: { type: "string", description: "3-letter IATA code, e.g. SFO." },
        },
        required: ["iata"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rankAirports",
      description:
        "Rank airports by expansion-opportunity score. Use for 'which airports are strong " +
        "candidates' questions. For a region or state question, pass states/region and do NOT also " +
        "set cohort — the answer should cover the whole region, and the result labels any cohort " +
        "spread itself. Set cohort only when the user asks about one size class.",
      parameters: {
        type: "object",
        properties: {
          cohort: {
            type: "string",
            enum: [...COHORTS],
            description: "Airport size class. Ranking within one cohort is the meaningful comparison.",
          },
          states: {
            type: "array",
            items: { type: "string" },
            description: "Two-letter US state codes, e.g. ['ME','NH'].",
          },
          region: {
            type: "string",
            enum: ["new_england"],
            description: "Named region shortcut. 'new_england' expands to ME, NH, VT, MA, RI, CT.",
          },
          metro: {
            type: "string",
            enum: [...METROS],
            description: "Restrict to the airports of one metro area.",
          },
          limit: {
            type: "integer",
            description: "How many to return, 1-25. Defaults to 5.",
          },
          weights: {
            type: "object",
            description:
              "Optional override of the four component weights, to answer 'what if we cared more " +
              "about X'. Values need not sum to 1; they are renormalised.",
            properties: {
              demandPressure: { type: "number" },
              capacityStrain: { type: "number" },
              growthMomentum: { type: "number" },
              frequencyConstraint: { type: "number" },
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compareAirports",
      description:
        "Compare two to six airports on congestion, load factor, taxi-out, aircraft size and route " +
        "count. Returns observations naming the differences that matter.",
      parameters: {
        type: "object",
        properties: {
          iataCodes: {
            type: "array",
            items: { type: "string" },
            description: "Two to six 3-letter IATA codes.",
          },
        },
        required: ["iataCodes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explainScore",
      description:
        "Break a score into its four components: raw value, percentile in cohort, weight, points " +
        "contributed. Also returns seasonal delay detail and a read of the profile. Use for any " +
        "'why' question — the component pattern matters more than the total.",
      parameters: {
        type: "object",
        properties: {
          iata: { type: "string", description: "3-letter IATA code." },
        },
        required: ["iata"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flightMix",
      description:
        "Traffic composition for one airport: haul split by passengers, domestic vs international, " +
        "freight tonnage, busiest routes, and routes running full. Use for 'percentage of long haul " +
        "flights' and for route-level evidence.",
      parameters: {
        type: "object",
        properties: {
          iata: { type: "string", description: "3-letter IATA code." },
        },
        required: ["iata"],
      },
    },
  },
];

// ------------------------------------------------------------------ validation helpers

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => (typeof x === "string" ? x.trim() : null)).filter((x): x is string => !!x);
  return out.length > 0 ? out : null;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.round(Number(v));
  }
  return undefined;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  const s = asString(v);
  if (!s) return undefined;
  return (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

function asWeights(v: unknown) {
  if (!v || typeof v !== "object") return undefined;
  const src = v as Record<string, unknown>;
  const keys = ["demandPressure", "capacityStrain", "growthMomentum", "frequencyConstraint"] as const;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const n = typeof src[k] === "number" ? (src[k] as number) : Number(src[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ------------------------------------------------------------------ dispatcher

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.function.name);

/**
 * Execute a tool call by name. Never throws: an unexpected failure becomes a structured error so
 * the agent loop can continue and the model can try something else.
 */
export function dispatchTool(name: string, args: Record<string, unknown>): ToolResult<unknown> {
  try {
    switch (name) {
      case "resolveAirport": {
        const query = asString(args.query);
        if (!query) return fail("invalid_parameters", "resolveAirport requires a non-empty 'query'.");
        return resolveAirport(query);
      }

      case "getAirportMetrics": {
        const iata = asString(args.iata);
        if (!iata) return fail("invalid_parameters", "getAirportMetrics requires an 'iata' code.");
        return getAirportMetrics(iata);
      }

      case "rankAirports": {
        const cohort = asEnum(args.cohort, COHORTS);
        const metro = asEnum(args.metro, METROS);
        const region = asEnum(args.region, ["new_england"] as const);

        // Reject unknown enum values explicitly rather than silently ignoring them: a silently
        // dropped filter produces a confident answer to a different question.
        if (args.cohort !== undefined && !cohort) {
          return fail(
            "invalid_parameters",
            `Unknown cohort ${JSON.stringify(args.cohort)}.`,
            [`Valid cohorts: ${COHORTS.join(", ")}`],
          );
        }
        if (args.metro !== undefined && !metro) {
          return fail(
            "invalid_parameters",
            `Unknown metro ${JSON.stringify(args.metro)}.`,
            [`Valid metros: ${METROS.join(", ")}`],
          );
        }
        if (args.region !== undefined && !region) {
          return fail("invalid_parameters", `Unknown region ${JSON.stringify(args.region)}.`, [
            "Valid regions: new_england. For anywhere else, pass 'states'.",
          ]);
        }

        return rankAirports({
          ...(cohort ? { cohort } : {}),
          ...(metro ? { metro } : {}),
          ...(region ? { region } : {}),
          ...(asStringArray(args.states) ? { states: asStringArray(args.states)! } : {}),
          ...(asInt(args.limit) !== undefined ? { limit: asInt(args.limit)! } : {}),
          ...(asWeights(args.weights) ? { weights: asWeights(args.weights)! } : {}),
        });
      }

      case "compareAirports": {
        const codes = asStringArray(args.iataCodes);
        if (!codes) {
          return fail(
            "invalid_parameters",
            "compareAirports requires 'iataCodes' as an array of at least two IATA codes.",
          );
        }
        return compareAirports(codes);
      }

      case "explainScore": {
        const iata = asString(args.iata);
        if (!iata) return fail("invalid_parameters", "explainScore requires an 'iata' code.");
        return explainScore(iata);
      }

      case "flightMix": {
        const iata = asString(args.iata);
        if (!iata) return fail("invalid_parameters", "flightMix requires an 'iata' code.");
        return flightMix(iata);
      }

      default:
        return fail("invalid_parameters", `Unknown tool "${name}".`, [
          `Available tools: ${TOOL_NAMES.join(", ")}`,
        ]);
    }
  } catch (err) {
    // A bug in a tool must not end the conversation.
    return fail(
      "invalid_parameters",
      `Tool "${name}" failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
