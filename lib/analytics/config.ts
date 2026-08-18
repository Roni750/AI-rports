/**
 * Analytics configuration.
 *
 * Small on purpose. Everything here is a value someone might reasonably want to change without
 * reading the code that consumes it — the same argument that puts the scoring weights in
 * `lib/scoring/config.ts`.
 */

/**
 * The tenant every locally-recorded session belongs to.
 *
 * A single-tenant demo does not need this, and that is precisely why it is here on day one.
 * Retrofitting a tenant dimension through a schema, a query layer and a dashboard is a multi-day
 * migration; carrying one column from the start costs nothing. For a product aimed at banks and
 * healthcare providers, the absence of a tenant boundary would be the first thing an enterprise
 * reviewer noticed.
 */
export const DEFAULT_TENANT = "demo";

/**
 * Stamped on every session so a behavioural change can be tied to a release.
 *
 * "The truncation rate tripled last Tuesday" is only actionable if you can tell which build the
 * affected sessions ran against.
 */
export const APP_VERSION = process.env.APP_VERSION ?? "dev";

/**
 * How long recorded conversations are kept.
 *
 * Enforced by `scripts/analytics-prune.ts` rather than automatically: a retention policy that runs
 * silently on a schedule nobody remembers is how data disappears mid-investigation.
 */
export const RETENTION_DAYS = 90;

/**
 * Below this many rows, a share is not a distribution and a line is not a trend.
 *
 * The query layer attaches a caveat and drops its stated confidence rather than letting a chart
 * imply more than the sample supports — the dashboard equivalent of the tool layer's rule that
 * assumptions travel as data.
 */
export const MIN_SAMPLE_FOR_SHARE = 20;
export const MIN_SAMPLE_FOR_TREND = 30;
