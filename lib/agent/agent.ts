import {
	checkRelayed,
	relayRate,
	resolveRequiredContext,
	type MustMention,
	type RequiredContextCheck,
} from "../tools/must-mention";
import {dispatchTool, TOOL_SCHEMAS} from "./tool-schemas";
import {systemPrompt} from "./system-prompt";

/**
 * The agent loop.
 *
 * Structurally a workflow with one agentic segment: the model chooses which tools to call and in
 * what order, but the set of tools is fixed, every call is validated, and the loop is bounded. That
 * is deliberate — a constrained system is predictable, and for an investment tool predictability
 * matters more than autonomy.
 *
 * Provider is Groq, whose API is OpenAI-compatible. Called over plain fetch rather than an SDK:
 * one dependency fewer, and the request shape is worth being explicit about.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Overridable so a model deprecation is a config change, not a code change — which already earned
 * its place: Groq removed the Llama 3.x family, so the original default stopped resolving.
 *
 * gpt-oss-120b is the strongest tool-caller currently on Groq's free tier, with a 131k context
 * window. `npm run models` lists what a given key can actually use.
 */
export const DEFAULT_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

/** Bounds the loop. Each iteration is one model call plus its tool executions. */
const MAX_ITERATIONS = 6;

/**
 * How long one model call may take before it is abandoned.
 *
 * Node's `fetch` has no default timeout, so a connection that opens and never responds holds the
 * request handler open indefinitely — no error, no log line, just a request that never finishes.
 * Generous enough that a slow-but-working answer is never cut off.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Wait, but give up the moment the caller does.
 *
 * A bare `setTimeout` between rate-limit retries ignores the abort signal, so a client that had
 * already disconnected still cost up to 30 seconds of a held request slot per retry — waiting to
 * produce an answer nobody was going to receive.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(signal!.reason);
		}
		signal?.addEventListener("abort", onAbort, {once: true});
	});
}

/**
 * Groq's free tier limits tokens per minute (8,000 at the time of writing), not requests, so the
 * binding constraint is payload size. Tool results are the largest single contributor, and much of
 * their bulk is noise: 14 significant figures on a load factor, arrays longer than any answer
 * needs, and null fields carrying no information.
 *
 * Compacting is not only a quota measure — a smaller, cleaner payload also keeps the model focused
 * on the figures that matter.
 */
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

/** Wait for a 429 to clear, using Groq's own reset hint when it gives one. */
function retryDelayMs(headers: Headers, attempt: number): number {
	const retryAfter = headers.get("retry-after");
	if (retryAfter && Number.isFinite(Number(retryAfter))) {
		return Math.min(Number(retryAfter) * 1000, 30_000);
	}
	// e.g. "26.895s"
	const reset = headers.get("x-ratelimit-reset-tokens") ?? headers.get("x-ratelimit-reset-requests");
	const m = reset ? /^([\d.]+)s$/.exec(reset.trim()) : null;
	if (m) return Math.min(Math.ceil(Number(m[1]) * 1000) + 500, 30_000);
	return Math.min(2000 * 2 ** attempt, 30_000);
}

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

interface ApiToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface ApiMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ApiToolCall[];
	tool_call_id?: string;
	name?: string;
}

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

/** Reported back so the caller can attribute a slow call to a retry rather than to generation. */
export interface CallStats {
	requestChars: number;
	rateLimitRetries: number;
	/** From the provider's own `usage` block. Null when it omitted one — never inferred. */
	promptTokens: number | null;
	completionTokens: number | null;
}

async function callModel(
	messages: ApiMessage[],
	apiKey: string,
	model: string,
	signal?: AbortSignal,
	withTools = true,
	stats?: CallStats,
): Promise<ApiMessage> {
	for (let attempt = 0; ; attempt++) {
		const payload = JSON.stringify({
			model,
			messages,
			// Omitting tools on the closing call saves the whole schema block, which is a meaningful
			// share of the token budget when no further tool calls are wanted anyway.
			...(withTools ? {tools: TOOL_SCHEMAS, tool_choice: "auto"} : {}),
			// Low but non-zero: tool selection should be near-deterministic, while prose stays readable.
			temperature: 0.2,
			max_tokens: 900,
		});
		if (stats && attempt === 0) stats.requestChars = payload.length;

		// The caller's signal AND a timeout: the first aborts when the user goes away, the second
		// when the provider stops answering. Either alone leaves one of the two hangs open.
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const res = await fetch(GROQ_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: payload,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});

		if (res.ok) {
			const json = (await res.json()) as {
				choices?: { message?: ApiMessage }[];
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			const message = json.choices?.[0]?.message;
			if (!message) throw new AgentError("Groq returned no message.", 502);
			if (stats) {
				// Token counts ride along on every response and used to be parsed and dropped. They
				// are the only non-estimated basis for a cost figure, so they are worth the two lines.
				stats.promptTokens = json.usage?.prompt_tokens ?? null;
				stats.completionTokens = json.usage?.completion_tokens ?? null;
			}
			return message;
		}

		const body = await res.text().catch(() => "");

		if (res.status === 401) {
			throw new AgentError("The Groq API key was rejected.", 401, "Check GROQ_API_KEY in .env.local.");
		}

		if (res.status === 429) {
			// Retry rather than failing: the token window resets in tens of seconds, and a demo that
			// recovers on its own is worth far more than one that shows an error.
			if (attempt < MAX_RATE_LIMIT_RETRIES) {
				if (stats) stats.rateLimitRetries++;
				await sleep(retryDelayMs(res.headers, attempt), signal);
				continue;
			}
			const remaining = res.headers.get("x-ratelimit-remaining-tokens");
			const reset = res.headers.get("x-ratelimit-reset-tokens");
			throw new AgentError(
				"Groq's rate limit is still in effect after retrying.",
				429,
				`The free tier allows about 8,000 tokens per minute` +
				(remaining ? `; ${remaining} remain` : "") +
				(reset ? `, resetting in ${reset}` : "") +
				". Wait a moment and ask again.",
			);
		}

		if (res.status === 404 || /model/i.test(body)) {
			throw new AgentError(
				`Model "${model}" was not accepted by Groq.`,
				400,
				"Set GROQ_MODEL in .env.local to a currently available model. Run: npm run models",
			);
		}

		throw new AgentError(`Groq returned ${res.status}: ${body.slice(0, 300)}`, 502);
	}
}

/** Parse the model's JSON arguments defensively — it does occasionally emit malformed JSON. */
function parseArgs(raw: string): { args: Record<string, unknown>; error?: string } {
	if (!raw || raw.trim() === "") return {args: {}};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return {args: parsed as Record<string, unknown>};
		}
		return {args: {}, error: "Arguments must be a JSON object."};
	} catch {
		return {args: {}, error: `Arguments were not valid JSON: ${raw.slice(0, 200)}`};
	}
}

export async function runAgent(
	history: ChatMessage[],
	options: { apiKey: string; model?: string; signal?: AbortSignal } = {apiKey: ""},
): Promise<AgentResult> {
	const {apiKey, signal} = options;
	const model = options.model ?? DEFAULT_MODEL;

	if (!apiKey) {
		throw new AgentError(
			"No Groq API key configured.",
			500,
			"Add GROQ_API_KEY=gsk_... to airport-agent/.env.local and restart the dev server.",
		);
	}

	const messages: ApiMessage[] = [
		{role: "system", content: systemPrompt()},
		...history.map((m) => ({role: m.role, content: m.content}) as ApiMessage),
	];

	const trace: ToolTraceEntry[] = [];
	// Accumulated across every tool call in the turn, then deduplicated and ordered once at the
	// end — a fact two tools both noticed should reach the reader once.
	const collectedMustMention: MustMention[] = [];
	let iterations = 0;

	const startedAt = Date.now();
	const modelMs: number[] = [];
	const requestChars: number[] = [];
	let rateLimitRetries = 0;
	let promptTokens: number | null = null;
	let completionTokens: number | null = null;
	let callsMissingUsage = 0;

	// The fixed prefix re-sent on every single call, measured once rather than estimated.
	const prefixChars = JSON.stringify({
		messages: [{role: "system", content: systemPrompt()}],
		tools: TOOL_SCHEMAS,
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
		msgs: ApiMessage[],
		withTools = true,
	): Promise<ApiMessage> => {
		const t0 = Date.now();
		const stats: CallStats = {
			requestChars: 0,
			rateLimitRetries: 0,
			promptTokens: null,
			completionTokens: null,
		};
		try {
			return await callModel(msgs, apiKey, model, signal, withTools, stats);
		} finally {
			// Recorded even on failure — a slow call that then errors is exactly the case worth seeing.
			modelMs.push(Date.now() - t0);
			requestChars.push(stats.requestChars);
			rateLimitRetries += stats.rateLimitRetries;

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

		const toolCalls = message.tool_calls ?? [];
		if (toolCalls.length === 0) {
			const reply = message.content?.trim() || "I could not produce an answer for that.";
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
		messages.push({
			role: "assistant",
			content: message.content ?? null,
			tool_calls: toolCalls,
		});

		for (const call of toolCalls) {
			const started = Date.now();
			const {args, error} = parseArgs(call.function.arguments);

			const result = error
				? {ok: false as const, code: "invalid_parameters" as const, message: error}
				: dispatchTool(call.function.name, args);

			if (result.ok && result.mustMention) collectedMustMention.push(...result.mustMention);

			trace.push({
				name: call.function.name,
				arguments: args,
				ok: result.ok,
				...(result.ok ? {} : {errorCode: result.code}),
				durationMs: Date.now() - started,
			});

			messages.push({
				role: "tool",
				tool_call_id: call.id,
				name: call.function.name,
				content: JSON.stringify(compactForModel(result)),
			});
		}
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
		closing.content?.trim() ||
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
