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
npm run verify             # typecheck + 56 tests
npm run data:smoke         # scoring engine against real data
npm run data:verify-tools  # the brief's four questions, end to end
npm run models             # list models the configured API key can use
```

---

## Project layout

```
lib/scoring/      deterministic scoring engine — percentiles, cohorts, robustness
lib/tools/        six typed tools; assumptions travel as data, not prose
lib/agent/        bounded tool-calling loop, tool schemas, system prompt
lib/data/         read-only SQLite access (the only file that knows the storage format)
app/api/chat/     chat endpoint (Node runtime — node:sqlite is unavailable on Edge)
app/page.tsx      chat UI with the tool trace panel
scripts/          Python data pipeline + TypeScript verification scripts
docs/             design documentation
```

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind 4 · `node:sqlite` (no native module) ·
Groq for inference · Python + pandas for offline data preparation only
