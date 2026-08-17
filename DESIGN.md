# Airport Investment Intelligence Agent — Design

An AI agent that helps analysts identify US airports where expansion is most warranted, over public
aviation data from the Bureau of Transportation Statistics.

**Diagrams:** [`docs/architecture-diagrams.md`](docs/architecture-diagrams.md) — system overview,
data pipeline, scoring flow, agent loop, ambiguity handling, and scope boundary.
**Deeper reading:** [`docs/scoring-methodology.md`](docs/scoring-methodology.md) explains the model
from first principles; [`docs/data-architecture.md`](docs/data-architecture.md) covers ingestion,
entity modelling, and how missing sources would be added.

---

## 1. The framing decision, first

The brief asks which airports make renovation most **profitable**. I did not build that, and the
reason matters more than anything else in this document.

Profitability requires construction cost, financing terms, concession revenue, and airline lease
structures. **None of it is public.** Any system claiming to rank profitability from flight data is
dressing up a guess as an answer.

What public aviation data *does* support rigorously:

> **A demand-side expansion-opportunity score** — evidence that passenger demand exceeds what an
> airport's current physical capacity can serve.

That is what this system measures. The gap between the two is stated everywhere it matters: in the
tool results, in the agent's system prompt, and in the answers themselves. When asked which airport
is most profitable to renovate, the agent says plainly that the data supports a demand-side ranking
and names what would additionally be required.

This is the largest scoping decision in the assignment, and naming it is the deliverable — not an
admission against it.

---

## 2. Scoring methodology

Four components, each converted to a **percentile rank within the airport's size cohort**, then
combined as a weighted sum on a 0–100 scale.

| Component | Weight | Measures | Why it indicates constraint |
|---|---|---|---|
| **Demand pressure** | 0.30 | Load factor (passengers ÷ seats) | Full aircraft mean carriers cannot seat more people without more seats |
| **Capacity strain** | 0.25 | NAS delay minutes per arrival | Direct evidence physical limits are being hit *today* |
| **Growth momentum** | 0.25 | Blended passenger growth, 2019→2024 and 2023→2024 | Expansion pays back over decades; a shrinking airport is not an opportunity |
| **Frequency constraint** | 0.20 | Seat growth minus departure growth | Carriers flying bigger aircraft rather than more flights — revealed preference that they *cannot* add flights |

### Why percentiles rather than raw values

The four measurements are in incompatible units — percent, minutes, percentage points. Adding
`83.2 + 7.98 + (−2.0) + 6.38` is meaningless arithmetic. Percentile ranking puts them on one scale.

It also bounds outliers. New Haven grew passengers ~510% between 2019 and 2024 because one carrier
opened a base there. Under raw values or z-scores that single number dominates any growth-weighted
composite; as a percentile it becomes "highest in its cohort," which is what it actually means.

### Why cohorts

The highest load factors in the United States belong to Harrisburg (86.8%) and Chattanooga (86.5%),
not Atlanta (84.7% across 274 routes). Ranking without peer groups puts Harrisburg above Atlanta as
an expansion candidate. Airports are therefore grouped by share of national passengers — mirroring
the FAA's hub classification, computed from the data rather than transcribed — and ranked only
within their group.

**Consequence:** scores are comparable *only within a cohort*. Any result spanning cohorts says so.

### How the weights were set

Not by intuition. `scripts/analyze-weights.ts` measures two properties of each component across the
31 large hubs:

**Discrimination** — a component where every airport scores the same carries no information:

| Component | sd | p25 | median | p75 | CV |
|---|---|---|---|---|---|
| Load factor | 1.8 | 81.0 | 82.3 | 83.2 | **2%** |
| NAS delay | 1.5 | 2.0 | 2.9 | 4.0 | 48% |
| Passenger growth | 5.3 | 0.6 | 4.7 | 9.2 | 109% |
| Upgauging | 4.9 | 6.0 | 8.9 | 12.8 | 55% |

Load factor barely separates airports at all — every large hub sits between 81% and 83.2% at the
quartiles, precisely because airlines all manage to the same target. It is causally the most direct
signal and the least informative one, which is why it carries 0.30 rather than more.

**Redundancy** — correlated components are one measurement counted twice. Among large hubs the four
are near-independent; upgauging correlates **0.00** with load factor, so it adds genuinely new
information. (In the medium-hub cohort growth and upgauging correlate 0.66 — at smaller airports,
fast growth partly *is* getting bigger aircraft. Disclosed rather than hidden.)

### The methodological finding worth reading

I proposed upgauging as a constraint signal, then tested its distribution before trusting it.
Between 2019 and 2024 the **median** US airport upgauged 12.5% while losing 2.8% of departures — an
industry-wide shift as carriers retreated from regional jets. Measured absolutely, the metric would
have flagged nearly every airport in the country as capacity-constrained.

The fix is to measure it as a percentile against peers, which is invariant to that level shift. The
general lesson is in the code: a metric that sounds principled still has to be checked against the
data before it earns a weight.

---

## 3. Key tradeoffs

### Demand-side score, not profitability
Covered above. **Cost:** does not answer the literal question. **Benefit:** every claim it makes is
supportable.

### Pre-ingest to SQLite rather than query live APIs
A committed script pulls from BTS once and builds a 5.8 MB database. **Cost:** freshness — the data
is a snapshot. **Benefit:** reliability, latency, reproducibility. T-100 is published with a
multi-month lag, so per-request freshness buys nothing real. A demo that dies on a rate limit is
worse than a documented snapshot.

### Python for data preparation, TypeScript for everything shipped
pandas is materially better at wrangling 390 MB of government CSVs. **The crucial point is that the
ingestion script is never deployed** — it runs on a developer machine and emits a small file, so
its language is a free choice. The shipped application is entirely TypeScript.

### Hand-tuned weights, disclosed as such
Calibration would require a labelled dataset of past airport expansions and their realised returns.
No such public dataset exists. **The weights are a defensible prior, not a fitted model** — which
is exactly why every ranking ships with a robustness note.

### Percentiles lose magnitude
Ranking discards *how much* better one airport is than the next. **Accepted** because the
components cannot otherwise be combined, and because bounded inputs prevent one outlier from
dominating.

### Scheduled passenger service only
Charter is excluded and cargo reported separately. Terminal expansion follows *scheduled* capacity;
charter is lumpy and doesn't justify permanent infrastructure. The exclusion is deliberate, and the
data hazard it avoids is real — BTS defines service classes `K`, `V` and `Z` as **aggregates** of
other classes, so summing across classes naively would double-count while still looking plausible.
The build asserts they are absent.

### A bounded agent loop rather than an autonomous one
Six iterations maximum, a fixed tool set, every parameter validated. **Cost:** it cannot improvise
beyond its tools. **Benefit:** predictable, debuggable, and cheap. For an investment tool,
predictability beats autonomy.

### Known limitations, stated
- **Delay data covers 195 of 728 airports** (larger reporting carriers only). Airports without it
  are not penalised: the missing component's weight is redistributed and the result records why.
- **Legal capacity caps are invisible.** Santa Ana operates under a noise curfew and a negotiated
  cap on passengers and daily departures. Its ceiling is a legal instrument, not a runway — and its
  80.2% load factor captures none of it.
- **An uncontrolled composition effect** in the frequency component: how much an airport upgauges
  depends partly on which carriers serve it. Percentile ranking removes the industry-wide level
  shift but not this. Correcting it needs a shift-share control.
- **Rankings are weight-sensitive.** Typically only one or two entries per cohort survive all six
  weightings tested. **This is a screening tool that narrows 392 airports to roughly ten worth human
  analysis, not an oracle that identifies the single best one.**

---

## 4. Where AI is used — and where it is not

### The rule

> **Every number the agent states comes from a tool result. The model never calculates, estimates,
> interpolates, or recalls a figure.**

This is enforced by structure, not by instruction. The model has no arithmetic capability exposed
to it and no access to raw data — only six typed functions that return computed results. For an
investment decision a fabricated figure is worse than no figure, so making it impossible beats
asking the prompt nicely.

### What the model does

1. **Routes** — chooses which of six tools answers the question, and with what parameters.
2. **Narrates** — turns structured results into prose an analyst can read.
3. **Handles ambiguity** — surfaces "LA could mean LAX or the whole basin" instead of guessing.

### What deterministic code does

Everything numeric: percentile ranking, cohort assignment, weighting, growth regularisation,
robustness re-ranking, haul classification, load factors, delay aggregation. All pure functions,
all unit-tested, all producing identical output for identical input.

### Assumptions are data, not prose

Every tool result carries its own `metricDefinitions`, `assumptions`, `dataVintage`, `caveats` and
a `confidence` tier as **structured fields**. The prompt's job is to relay them. You cannot forget
to state an assumption when the data layer emits it.

### `mustMention` — and why it exists

One field is not advisory. `mustMention` carries context an answer is *wrong* without, and the
prompt treats it as mandatory.

It exists because the softer version failed. Told that caveats were "worth including where they
matter," the model dropped Anchorage's freight note — 5.75 billion pounds of cargo against 2.66
million passengers, which is the single most important fact for interpreting that airport's
passenger figures. Strengthening the wording to "almost always worth including" did not fix it.
Moving the content into a required field did, first try.

**A prompt is advice; a required field is a rule.** Advice gets weighed against other advice and
can lose. It now carries the freight note, metro-catchment relationships, and every ranking's
robustness note.

### The tool trace is a feature, not debug output

The UI shows every tool call behind each answer. It is the visible proof of the architecture: a
reader can confirm the figures came from named functions rather than from the model.

---

## 5. The four questions in the brief

Each contains a trap, handled in the tool layer rather than the prompt.

**"Which airports in New England are strong candidates for terminal expansion?"**
Explicit documented state set (ME/NH/VT/MA/RI/CT). Returns Bangor 86.2, New Haven 71.6, Portland
69.4, Nantucket 68.4, Worcester 64.6 — plus the robustness note and a warning that the list spans
size cohorts. *Bangor ranking first is a genuine finding: it is a non-hub, invisible under any
ranking that filters small airports out.*

**"Compare LA and Santa Ana airport congestion levels."**
Doubly ambiguous. "LA" could mean LAX or all five basin airports — **and Santa Ana is itself inside
greater Los Angeles**, so this compares a metro to its own second-busiest airport. The agent
surfaces both readings and labels the comparison as two airports within one market. On the numbers:
LAX 2.04 NAS delay minutes per arrival against SNA's 1.45, and 84.4% load factor against 80.2%.

**"What is the percentage of long haul flights out of Anchorage airport?"**
22.3% of passengers on flights of 2,400+ miles — with the definition that shares are *of
passengers, not flights* (a long-haul flight carries more people), the note that haul thresholds
are this system's convention rather than an industry standard, and the fact that **ANC moved 5.75
billion pounds of freight**, which is the bigger story at one of the world's top cargo airports.

**"What is the unmet flight demand in SFO airport and why?"**
The most interesting one. "Unmet demand" is not a data field, so it has to be *defined*. SFO's
profile: 98.4th percentile on delay (the worst large hub in the country) but 11.3th on growth,
with passengers still below 2019 and departures down ~17%.

So the naive reading — "SFO is full" — is unsupported. The real answer comes from seasonality: NAS
delay swings **6.2x**, from 16.75 minutes per arrival in April to 2.70 in July, while *extreme
weather* delay stays flat. Those are different mechanisms. Storms would raise weather delay; what
this shows is **throughput reduction** — SFO's closely-spaced parallel runways cannot support
independent approaches in poor visibility, so arrival rate falls for a third of the year.

**Unmet demand at SFO is capacity suppression, not seat scarcity — and more terminal space would
not fix it.** Route-level evidence backs the constraint: SFO–MDW 93.0%, SFO–DOH 91.8%, SFO–CLT
91.5%.

---

## 6. Running it

```bash
npm install
cp .env.local.example .env.local        # add GROQ_API_KEY
npm run dev                             # localhost:3000
```

The dataset is committed, so no ingestion is needed to run the app. To rebuild from source:

```bash
npm run data:download    # ~390 MB from BTS, ~10 min
npm run data:build       # -> data/aviation.db
```

Verification:

```bash
npm run verify           # typecheck + 56 tests
npm run data:smoke       # scoring engine against real data
npm run data:verify-tools # the four questions end to end
npm run models           # list models the configured key can use
```

---

## 7. What I would do next

In priority order, with reasons rather than a wishlist:

1. **Validate against known answers.** The FAA publishes which airports are slot-controlled. If the
   model does not rank those highly, the model is wrong — a free external validation set I did not
   have time to build.
2. **Fuzzy airport matching.** Currently exact code, substring city match, or state. "Kennedy"
   misses JFK because only *city* names were ingested, not airport names — half a data problem,
   half an algorithm one. It becomes important with voice input, where a clarification costs a whole
   spoken round trip.
3. **Voice (STT/TTS).** Listed as a bonus in the brief. Groq hosts Whisper, and its audio limits are
   metered separately from chat tokens, so it costs nothing against the chat budget.
4. **Evals for the non-deterministic half.** The scoring engine is unit-tested; the model wrapped
   around it is not. The highest-value check is **numeric fidelity** — assert that every number in
   an answer appears in the tool output it came from. That catches invented figures programmatically,
   with no judge model required.
5. **Shift-share control** on the frequency component, to remove the carrier-mix confound.
6. **Gate and rate-limit the deployed demo.** A public URL with a server-side API key means anyone
   who finds it can spend the quota.
