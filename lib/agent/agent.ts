import {
	checkRelayed,
	relayRate,
	resolveRequiredContext,
	type MustMention,
	type RequiredContextCheck,
} from "../tools/must-mention";
import Anthropic from "@anthropic-ai/sdk";

import {type ChartPayload, payloadFor} from "../tools/chart-payload";
import {dispatchTool, TOOL_SCHEMAS} from "./tool-schemas";
import {systemPrompt} from "./system-prompt";



const MAX_RATE_LIMIT_RETRIES = 2;

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

/** A record of one tool execution, surfaced to the UI so the data path is visible. */
export interface ToolTraceEntry {
	name: string;
	arguments: Record<string, unknown>;
	ok: boolean;
	/** Error code when the call failed, so failures are legible in the trace. */
	errorCode?: string;
	durationMs: number;
	/**
	 * The tool's own result, for the interface to draw.
	 *
	 * Deliberately the FULL result, not the compacted one sent to the model: compaction
	 * rounds numbers and drops nulls, which is right for a prompt and wrong for a chart.
	 * Absent on failure, and on tools with no visual treatment.
	 */
	payload?: ChartPayload;
}

/**
 * Where the wall-clock time actually went.
 *
 * Added for the voice work. After a user stops speaking the agent loop is by far the largest term
 * in the budget, and whether it is 1.5s or 5s decides how much perceived-latency engineering is
 * worth doing. Measuring beats estimating.
 */
export interface AgentTiming {
	/** One entry per model call, in order. */
	modelMs: number[];
	/** Sum of all model calls — expected to dominate. */
	totalModelMs: number;
	/** Sum of all tool executions. Local SQLite, so expected to be negligible. */
	totalToolMs: number;
	/** End to end inside runAgent. */
	totalMs: number;
	/**
	 * Serialized request size per model call, in characters.
	 *
	 * The whole conversation is re-sent on every iteration — system prompt, tool schemas, history,
	 * and every prior tool result. That growth is what consumes a tokens-per-minute budget, so it
	 * has to be visible before it can be argued about.
	 */
	requestChars: number[];
	/** Fixed prefix re-sent every call: system prompt + tool schemas. */
	prefixChars: number;
	/** Sum of requestChars — the real cost of one question. */
	totalRequestChars: number;
	/** Model calls that were retried because of a 429. Long modelMs values are usually this. */
	rateLimitRetries: number;
	/**
	 * Prefix tokens served from cache across the turn, billed at 0.1x.
	 *
	 * Surfaced because a cache that silently stops working looks like nothing at all — the answers
	 * stay correct and only the bill moves. Zero here across repeated questions means something
	 * changed the prefix bytes.
	 */
	cacheReadTokens: number;
}

/**
 * Tokens consumed across every model call in one answer.
 *
 * Deliberately raw counts and no dollar figure. Converting to money needs a price table, and a
 * price is a fact about a vendor's website rather than about this loop — so it lives in
 * `lib/analytics/pricing.ts` and is applied at the boundary. That keeps the agent free of any
 * dependency on the analytics layer, and keeps one place to fix when a rate changes.
 *
 * Null means the provider did not report usage, which is different from zero.
 */
export interface AgentUsage {
	promptTokens: number | null;
	completionTokens: number | null;
	/** Model calls that reported no usage block, so a null total can be explained rather than hidden. */
	callsMissingUsage: number;
}

export interface AgentResult {
	reply: string;
	trace: ToolTraceEntry[];
	/**
	 * Facts the tools marked as required, and whether the answer actually carried each one.
	 *
	 * The point of checking rather than only asking: a dropped fact and a relayed one look
	 * identical from the outside, so without this the guarantee is an assertion. With it, relay
	 * compliance becomes a number that can be watched over time.
	 */
	requiredContext: RequiredContextCheck[];
	/** Share of required facts relayed, or null when the turn required none. */
	requiredContextRelayRate: number | null;
	iterations: number;
	model: string;
	/** Set when the loop hit its iteration cap without the model producing a final answer. */
	truncated: boolean;
	timing: AgentTiming;
	usage: AgentUsage;
}

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

/**
 * Bounds the loop. Each iteration is one model call plus its tool executions.
 *
 * Three rather than six: every iteration re-sends the whole conversation, so a long turn multiplies
 * the fixed prefix (system prompt plus six tool schemas) by the number of calls. Little is lost —
 * a turn that needed six iterations was hitting the cap and truncating anyway.
 */
const MAX_ITERATIONS = 3;

/** How long one model call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 60_000;

const MODEL_PAYLOAD_LIMITS = {
	maxArrayLength: 8,
	/** Values below this get 2 decimals; above it, whole numbers. Passenger counts don't need decimals. */
	decimalThreshold: 1000,
};

function compactForModel(value: unknown): unknown {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		if (Number.isInteger(value)) return value;
		return Math.abs(value) < MODEL_PAYLOAD_LIMITS.decimalThreshold
			? Math.round(value * 100) / 100
			: Math.round(value);
	}
	if (Array.isArray(value)) {
		return value.slice(0, MODEL_PAYLOAD_LIMITS.maxArrayLength).map(compactForModel);
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			// Drop nulls, undefined and empty arrays: absent is the same as null here, and the schema
			// already tells the model which fields exist.
			if (v === null || v === undefined) continue;
			if (Array.isArray(v) && v.length === 0) continue;
			out[k] = compactForModel(v);
		}
		return out;
	}
	return value;
}

/** Reported back so the caller can attribute a slow call to a retry rather than to generation. */
export class AgentError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly hint?: string,
	) {
		super(message);
		this.name = "AgentError";
	}
}

export interface CallStats {
	requestChars: number;
	rateLimitRetries: number;
	/** From the provider's own `usage` block. Null when it omitted one — never inferred. */
	promptTokens: number | null;
	completionTokens: number | null;
	/** Prefix tokens served from cache at 0.1x. Zero on a cold call, high on every call after. */
	cacheReadTokens: number;
}

/**
 * The tool schemas, translated from the OpenAI function shape into Anthropic's.
 *
 * `tool-schemas.ts` stays in the OpenAI shape on purpose: `dispatchTool` and its per-parameter
 * validation are the load-bearing part of the tool boundary, and a provider swap has no business
 * touching them. Translating here keeps the change to one function.
 *
 * Computed once — the schemas are static, and rebuilding them per call would defeat prompt caching,
 * which keys on the exact bytes of the tools block.
 */
const ANTHROPIC_TOOLS: Anthropic.Tool[] = TOOL_SCHEMAS.map((t) => ({
	name: t.function.name,
	description: t.function.description,
	input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
}));

let client: Anthropic | null = null;

function anthropic(apiKey: string): Anthropic {
	if (!client) client = new Anthropic({apiKey, maxRetries: MAX_RATE_LIMIT_RETRIES});
	return client;
}

async function callModel(
	messages: Anthropic.MessageParam[],
	apiKey: string,
	model: string,
	signal?: AbortSignal,
	withTools = true,
	stats?: CallStats,
	onDelta?: (delta: string) => void,
): Promise<Anthropic.Message> {
	const params: Anthropic.MessageCreateParamsNonStreaming = {
		model,
		/*
		 * Cached as a block rather than a bare string.
		 *
		 * The system prompt and the six tool schemas are ~1,700 tokens that never change, and they
		 * were being re-sent at full price on every model call — twice per turn, since the loop
		 * calls once to pick a tool and again to narrate the result. Caching bills the write at
		 * 1.25x once and every later read at 0.1x, so it pays for itself inside a single turn.
		 *
		 * The breakpoint goes on the LAST cacheable block of the prefix. Tools render before the
		 * system prompt, so marking the system block caches the tool schemas along with it.
		 * Everything volatile — the conversation, the tool results — sits after this point and is
		 * billed normally, which is what keeps the cached prefix byte-identical between calls.
		 */
		system: [
			{
				type: "text",
				text: systemPrompt(),
				cache_control: {type: "ephemeral"},
			},
		],
		messages,
		// Omitting tools on the closing call saves the whole schema block, which is a meaningful
		// share of the token budget when no further tool calls are wanted anyway.
		...(withTools ? {tools: ANTHROPIC_TOOLS} : {}),
		/*
		 * No `temperature`. Sampling parameters are rejected outright on this model class, and the
		 * old value (0.2, for near-deterministic tool selection) has no equivalent knob — tool
		 * choice is steered by the schemas and the system prompt instead.
		 *
		 * `max_tokens` is large because thinking is on by default and this ceiling covers thinking
		 * AND the reply together; the previous 900 would have been consumed before the answer
		 * started. Effort is low deliberately: this agent's job is to route to a tool and narrate
		 * the result, which is not the kind of work that rewards deep deliberation, and latency is
		 * what a user actually feels here.
		 */
		max_tokens: 16_000,
		output_config: {effort: "low"},
	};

	if (stats) stats.requestChars = JSON.stringify(params).length;

	try {
		// The caller's signal AND a timeout: the first aborts when the user goes away, the second
		// when the provider stops answering. Either alone leaves one of the two hangs open.
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		/*
		 * Streamed even when nobody is listening for deltas. Beyond the UI, it removes the HTTP
		 * timeout that a large max_tokens would otherwise risk on a non-streaming request.
		 */
		const stream = anthropic(apiKey).messages.stream(params, {
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (onDelta) stream.on("text", onDelta);
		const message = await stream.finalMessage();

		if (stats) {
			// Token counts ride along on every response and used to be parsed and dropped. They
			// are the only non-estimated basis for a cost figure, so they are worth the two lines.
			/*
			 * `input_tokens` counts only the UNCACHED remainder — the cached prefix is reported
			 * separately. Summing all three is what makes the cost figure comparable to the
			 * pre-caching numbers; reading input_tokens alone would show a sudden 70% "drop" in
			 * prompt size that never happened.
			 */
			const cacheRead = message.usage.cache_read_input_tokens ?? 0;
			const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
			stats.promptTokens = (message.usage.input_tokens ?? 0) + cacheRead + cacheWrite;
			stats.completionTokens = message.usage.output_tokens ?? null;
			stats.cacheReadTokens = cacheRead;
		}

		/*
		 * Safety classifiers can decline a request and return a perfectly successful HTTP 200 whose
		 * `content` is empty. Checked here rather than at the read site because every caller would
		 * otherwise have to remember to check before indexing into the content blocks.
		 */
		if (message.stop_reason === "refusal") {
			throw new AgentError(
				"The model declined to answer that.",
				400,
				message.stop_details?.explanation ??
					"Rephrase the question, or ask about a different airport.",
			);
		}

		return message;
	} catch (err) {
		if (err instanceof AgentError) throw err;

		// Typed SDK errors, most specific first. The SDK already retries 429 and 5xx with backoff
		// (maxRetries above), so reaching a rate-limit catch here means the retries were exhausted.
		if (err instanceof Anthropic.AuthenticationError) {
			throw new AgentError(
				"The Anthropic API key was rejected.",
				401,
				"Check ANTHROPIC_API_KEY in .env.local.",
			);
		}
		if (err instanceof Anthropic.RateLimitError) {
			if (stats) stats.rateLimitRetries = MAX_RATE_LIMIT_RETRIES;
			throw new AgentError(
				"Anthropic's rate limit is still in effect after retrying.",
				429,
				"Wait a moment and ask again, or check the usage limits on the API key.",
			);
		}
		if (err instanceof Anthropic.NotFoundError) {
			throw new AgentError(
				`Model "${model}" was not accepted by Anthropic.`,
				400,
				"Set ANTHROPIC_MODEL in .env.local to a currently available model. Run: npm run models",
			);
		}
		if (err instanceof Anthropic.APIError) {
			throw new AgentError(
				`Anthropic returned an error (${err.status ?? "unknown"}).`,
				err.status ?? 502,
				err.message,
			);
		}
		throw err;
	}
}

/** The assistant's own text, concatenated. Thinking blocks carry no text and are skipped. */
function textOf(message: Anthropic.Message): string {
	return message.content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
}

/**
 * Progress from a turn, as it happens.
 *
 * A turn is two model calls with a tool execution between them, and the answer text only exists
 * after the second. Emitting the tool result the moment it lands means the chart renders while the
 * model is still writing the prose about it — which is most of the perceived-latency win here, more
 * than the text deltas are.
 *
 * `done` carries everything that can only be known once the reply is complete, the mustMention
 * check above all: whether a required fact was relayed is a property of the finished text.
 */
export type AgentEvent =
	| {type: "tool_start"; name: string}
	| {type: "tool_done"; entry: ToolTraceEntry}
	| {type: "text"; delta: string}
	| {type: "done"; result: AgentResult};

export async function runAgent(
	history: ChatMessage[],
	options: {
		apiKey: string;
		model?: string;
		signal?: AbortSignal;
		/** Called as the turn unfolds. Omit it and the turn behaves exactly as before. */
		onEvent?: (event: AgentEvent) => void;
	} = {apiKey: ""},
): Promise<AgentResult> {
	const {apiKey, signal, onEvent} = options;
	const model = options.model ?? DEFAULT_MODEL;

	if (!apiKey) {
		throw new AgentError(
			"No Anthropic API key configured.",
			500,
			"Add ANTHROPIC_API_KEY=sk-ant-... to airport-agent/.env.local and restart the dev server.",
		);
	}

	const messages: Anthropic.MessageParam[] = history.map((m) => ({
		role: m.role,
		content: m.content,
	}));

	const trace: ToolTraceEntry[] = [];
	// Accumulated across every tool call in the turn, then deduplicated and ordered once at the
	// end — a fact two tools both noticed should reach the reader once.
	const collectedMustMention: MustMention[] = [];
	let iterations = 0;

	const startedAt = Date.now();
	const modelMs: number[] = [];
	const requestChars: number[] = [];
	let rateLimitRetries = 0;
	let cacheReadTokens = 0;
	let promptTokens: number | null = null;
	let completionTokens: number | null = null;
	let callsMissingUsage = 0;

	// The fixed prefix re-sent on every single call, measured once rather than estimated.
	const prefixChars = JSON.stringify({
		system: systemPrompt(),
		tools: ANTHROPIC_TOOLS,
	}).length;

	const timing = (): AgentTiming => ({
		modelMs,
		totalModelMs: modelMs.reduce((a, b) => a + b, 0),
		totalToolMs: trace.reduce((a, t) => a + t.durationMs, 0),
		totalMs: Date.now() - startedAt,
		requestChars,
		prefixChars,
		totalRequestChars: requestChars.reduce((a, b) => a + b, 0),
		rateLimitRetries,
		cacheReadTokens,
	});

	const usage = (): AgentUsage => ({promptTokens, completionTokens, callsMissingUsage});

	/** Resolves the required-context set against a finished answer. */
	const withRequiredContext = (reply: string) => {
		const required = resolveRequiredContext(collectedMustMention);
		const requiredContext = checkRelayed(required, reply);
		return {requiredContext, requiredContextRelayRate: relayRate(requiredContext)};
	};

	/** Wraps every model call so no timing path can be forgotten. */
	const timedCall = async (
		msgs: Anthropic.MessageParam[],
		withTools = true,
	): Promise<Anthropic.Message> => {
		const t0 = Date.now();
		const stats: CallStats = {
			requestChars: 0,
			rateLimitRetries: 0,
			promptTokens: null,
			completionTokens: null,
			cacheReadTokens: 0,
		};
		try {
			return await callModel(msgs, apiKey, model, signal, withTools, stats, (delta) =>
				onEvent?.({type: "text", delta}),
			);
		} finally {
			// Recorded even on failure — a slow call that then errors is exactly the case worth seeing.
			modelMs.push(Date.now() - t0);
			requestChars.push(stats.requestChars);
			rateLimitRetries += stats.rateLimitRetries;
			cacheReadTokens += stats.cacheReadTokens;

			// Summed across calls, but a missing report must not silently read as zero: totals stay
			// null until at least one call reports, and every gap is counted so the total can be
			// labelled partial rather than quietly understating spend.
			if (stats.promptTokens === null && stats.completionTokens === null) {
				callsMissingUsage++;
			} else {
				promptTokens = (promptTokens ?? 0) + (stats.promptTokens ?? 0);
				completionTokens = (completionTokens ?? 0) + (stats.completionTokens ?? 0);
			}
		}
	};

	while (iterations < MAX_ITERATIONS) {
		iterations++;
		const message = await timedCall(messages);

		const toolCalls = message.content.filter(
			(b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
		);
		if (toolCalls.length === 0) {
			const reply = textOf(message) || "I could not produce an answer for that.";
			return {
				reply,
				...withRequiredContext(reply),
				trace,
				iterations,
				model,
				truncated: false,
				timing: timing(),
				usage: usage(),
			};
		}

		// The assistant turn carrying the tool calls must be preserved verbatim, or the tool results
		// that follow have nothing to attach to.
		messages.push({role: "assistant", content: message.content});

		/*
		 * Every result from this turn goes back in ONE user message. Splitting them across several
		 * messages is accepted by the API but teaches the model to stop calling tools in parallel,
		 * which costs an extra round trip on any question that touches two airports.
		 */
		const toolResults: Anthropic.ToolResultBlockParam[] = [];

		for (const call of toolCalls) {
			const started = Date.now();
			onEvent?.({type: "tool_start", name: call.name});
			// `input` arrives already parsed, so there is no JSON string to decode and no parse
			// error to handle — dispatchTool still validates every parameter.
			const args = (call.input ?? {}) as Record<string, unknown>;
			const result = dispatchTool(call.name, args);

			if (result.ok && result.mustMention) collectedMustMention.push(...result.mustMention);

			const payload = payloadFor(call.name, result);

			const entry: ToolTraceEntry = {
				name: call.name,
				arguments: args,
				ok: result.ok,
				...(result.ok ? {} : {errorCode: result.code}),
				durationMs: Date.now() - started,
				...(payload ? {payload} : {}),
			};
			trace.push(entry);
			// Carries the chart payload, so the client can draw before any prose exists.
			onEvent?.({type: "tool_done", entry});

			toolResults.push({
				type: "tool_result",
				tool_use_id: call.id,
				content: JSON.stringify(compactForModel(result)),
				...(result.ok ? {} : {is_error: true}),
			});
		}

		messages.push({role: "user", content: toolResults});
	}

	// Cap reached. Ask once for a final answer with no tools, rather than returning nothing.
	const closing = await timedCall(
		[
			...messages,
			{
				role: "user",
				content:
					"Answer now using only the tool results already gathered. Do not request more tools. " +
					"If something is still missing, say what and why.",
			},
		],
		false,
	);

	const closingReply =
		textOf(closing) ||
		"I gathered data but could not complete an answer within the step limit.";

	return {
		reply: closingReply,
		...withRequiredContext(closingReply),
		trace,
		iterations,
		model,
		truncated: true,
		timing: timing(),
		usage: usage(),
	};
}
