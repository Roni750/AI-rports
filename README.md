# Airport Investment Intelligence Agent

An AI agent that helps analysts identify US airports where expansion is most warranted, using
public aviation data from the Bureau of Transportation Statistics.

Ask it questions in plain English:

> *Which airports in New England are strong candidates for terminal expansion?*
> *Compare LA and Santa Ana airport congestion levels.*
> *What is the unmet flight demand in SFO airport and why?*

---

## The one thing to know about the architecture

**The language model computes nothing.** It chooses which of six tools to call, passes parameters,
and narrates the results. Every figure in every answer originates in deterministic, unit-tested
TypeScript below the tool boundary.

For an investment decision, a fabricated number is worse than no number — so this is enforced by
structure rather than by asking the prompt nicely. The chat UI shows the tool trace behind each
answer, making it auditable.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local     # add your GROQ_API_KEY
npm run dev                          # http://localhost:3000
```

Get a free Groq key at [console.groq.com](https://console.groq.com). The dataset is committed, so
no ingestion step is needed to run the app.

---

## Documentation

| Document | What's in it |
|---|---|
| **[DESIGN.md](DESIGN.md)** | Scoring methodology, key tradeoffs, where AI is used — **start here** |
| [docs/architecture-diagrams.md](docs/architecture-diagrams.md) | System overview, data pipeline, scoring flow, agent loop, ambiguity handling |
| [docs/scoring-methodology.md](docs/scoring-methodology.md) | The model from first principles, no jargon assumed |
| [docs/data-architecture.md](docs/data-architecture.md) | Ingestion, entity modelling, how missing sources would be added |

---

## What it measures

A **demand-side expansion-opportunity score** — evidence that passenger demand exceeds what an
airport's current physical capacity can serve.

**Not profitability.** Construction cost, financing terms and concession revenue are not public, so
no honest system can rank profitability from flight data. That boundary is stated in the answers
themselves, not buried here.

Four components, each converted to a percentile within the airport's size cohort, then weighted:

| Component | Weight | Measures |
|---|---|---|
| Demand pressure | 0.30 | Load factor — are the aircraft full? |
| Capacity strain | 0.25 | NAS delay per arrival — is the airport struggling today? |
| Growth momentum | 0.25 | Passenger growth — is demand still rising? |
| Frequency constraint | 0.20 | Bigger aircraft rather than more flights — revealed inability to add flights |

Every ranking ships with a **robustness note** stating which entries survive alternative weightings,
because the weights are a judgement call and the product should say so.

---

## Data

| Source | Coverage |
|---|---|
| BTS T-100 Segment (all carriers) | 2019, 2023, 2024 — passengers, seats, departures, distance, freight |
| BTS On-Time Performance | All 12 months of 2024 — delay minutes with cause attribution |

~390 MB of raw government files are reduced offline to a **5.8 MB SQLite database** that is
committed and deployed with the app. The application never parses a CSV.

Rebuild from source:

```bash
npm run data:download    # pulls from BTS, ~10 minutes
npm run data:build       # -> data/aviation.db
```

---

## Verification

```bash
npm run verify             # typecheck + 150 tests, incl. classifier accuracy floors
npm run data:smoke         # scoring engine against real data
npm run data:verify-tools  # the brief's four questions, end to end
npm run models             # list models the configured API key can use
npm run eval:topics        # topic classifier P/R/F1 + confusion matrix (no network)
```

---

## Project layout

```
lib/scoring/      deterministic scoring engine — percentiles, cohorts, robustness
lib/tools/        six typed tools; assumptions travel as data, not prose
lib/agent/        bounded tool-calling loop, tool schemas, system prompt
lib/data/         read-only SQLite access (the only file that knows the storage format)
lib/analytics/    conversation analytics — store, taxonomy, classifier, queries, eval
app/api/chat/     chat endpoint (Node runtime — node:sqlite is unavailable on Edge)
app/page.tsx      chat UI with the tool trace panel
app/analytics/    the analytics dashboard (server components; Recharts confined to charts.tsx)
scripts/          Python data pipeline + TypeScript verification scripts
docs/             design documentation
```

## Conversation analytics

`/analytics` reports what people ask, what each answer costs, and where the system degrades. Every
turn is persisted with its tool trace, tokens, cost and latency, and every prompt is grouped under
one of ten umbrella topics by a two-stage classifier — deterministic rules first, a model only on
what they decline. On the labelled gold set the rule stage resolves **98.4% of prompts at $0**.

Accuracy is measured rather than asserted: `npm run eval:topics` prints per-class precision, recall
and F1 plus a confusion matrix, and `npm run verify` enforces floors so a regression fails the build
without needing a network or an API key. See DESIGN.md §6 for what that score does and does not mean.

```bash
npm run analytics:migrate   # idempotent
npm run analytics:seed      # replay a corpus through the real agent (~7 min) so the demo has data
npm run analytics:classify  # label anything the inline rule stage declined
```

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind 4 · `node:sqlite` (read-only dataset) ·
libSQL/Turso (analytics) · Recharts · Groq for inference ·
Python + pandas for offline data preparation only
