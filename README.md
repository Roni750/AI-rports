# Airport Investment Intelligence Agent

An AI agent that helps analysts identify US airports where expansion is most warranted, using
public aviation data from the Bureau of Transportation Statistics.

Ask it questions in plain English:

> *Which airports in New England are strong candidates for terminal expansion?*
> *Compare LA and Santa Ana airport congestion levels.*
> *What is the percentage of long haul flights out of Anchorage airport?*
> *What is the unmet flight demand in SFO airport and why?*

**The one thing to know about the architecture:** the language model computes nothing. It chooses
which of six tools to call, passes parameters, and narrates the results. Every figure in every
answer originates in deterministic, unit-tested TypeScript below the tool boundary — and the UI
shows the tool trace behind each answer, so you can check.

---

## Getting started

### Requirements

| | |
|---|---|
| **Node 22.5 or newer** | The data layer uses the built-in `node:sqlite` module, which does not exist on older versions. Run `node -v` to check; get it from [nodejs.org](https://nodejs.org). |
| **A Groq API key** | Free, no card, about a minute: [console.groq.com](https://console.groq.com) → **API Keys** → *Create API Key*. |
| Python 3 | **Only** if you want to rebuild the dataset from source. Not needed to run the app. |

### Four commands

```bash
git clone https://github.com/Roni750/AI-rports.git
cd AI-rports
npm install
cp .env.local.example .env.local     # then paste your Groq key into it
npm run dev
```

Open **http://localhost:3000**.

**The dataset is committed to the repository**, so there is no ingestion, migration, or seeding
step. It runs straight from a clone.

### If anything looks wrong

```bash
npm run doctor
```

Checks the Node version, `node:sqlite` availability, dependencies, both databases and your API key,
then says exactly what to do about anything it finds. It needs nothing installed to run.

<details>
<summary><b>Troubleshooting</b></summary>

**`Cannot find module 'node:sqlite'`** — Node is older than 22.5. Upgrade; there is nothing to
install, it is a built-in module.

**`Cannot find name 'PageProps'` or `'LayoutProps'`** — Next 16 generates these types on first
build, so a clean clone has not got them yet. `npm run typecheck` generates them itself, so this
should not appear; if it does, run `npx next typegen`.

**"No Groq API key configured"** — `.env.local` is missing or has no `GROQ_API_KEY`. Copy
`.env.local.example` and paste a key from [console.groq.com](https://console.groq.com).

**"Model was not accepted by Groq"** — providers deprecate model names (Groq removed the Llama 3.x
family during development). Run `npm run models` to list what your key can use, then set
`GROQ_MODEL` in `.env.local`.

**"Groq's rate limit is still in effect"** — the free tier allows about 8,000 tokens per minute and
one question uses roughly half of that. Wait a minute between questions; the app already retries
with backoff. The measurements behind this are in [DESIGN.md](DESIGN.md).

**Port 3000 already in use** — Next picks the next free port and prints it.

</details>

---

## Try these first

Type them into the chat, and **click "Show data sources"** under an answer to see the tool calls
behind it. Each exercises a different capability:

| Question | What to watch for |
|---|---|
| *Which airports in New England are strong candidates for terminal expansion?* | Bangor, Maine ranks first — a non-hub that most rankings would filter out entirely. The answer flags that the list spans size cohorts. |
| *Compare LA and Santa Ana airport congestion levels.* | It **asks which "LA" you mean** — LAX alone, or the whole basin — rather than guessing. Santa Ana is itself inside greater Los Angeles, and the answer says so. |
| *What is the percentage of long haul flights out of Anchorage airport?* | 22.3%, with the gloss that shares are *of passengers, not flights* — plus Anchorage's 5.75 billion pounds of freight, which is the bigger story at one of the world's top cargo airports. |
| *What is the unmet flight demand in SFO airport and why?* | The interesting one. SFO is the most delay-constrained large hub in the country while *shrinking*, so "it's full" is unsupported — the answer explains what is really happening. |

> **Leave about a minute between questions.** The free Groq tier caps tokens per minute.

There is also a dashboard at **http://localhost:3000/analytics** — cost, latency, token use, tool
calls and topic mix across conversations.

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
themselves, not buried in a document.

Four components, each converted to a percentile within the airport's size cohort, then weighted:

| Component | Weight | Measures |
|---|---|---|
| Demand pressure | 0.30 | Load factor — are the aircraft full? |
| Capacity strain | 0.25 | Delay attributable to the airport rather than the airline |
| Growth momentum | 0.25 | Passenger growth — is demand still rising? |
| Frequency constraint | 0.20 | Bigger aircraft rather than more flights — revealed inability to add flights |

Every ranking ships with a **robustness note** saying which entries survive alternative weightings,
because the weights are a judgement call and the product should say so.

---

## Verifying it

```bash
npm run verify             # typecheck + tests
npm run data:smoke         # scoring engine against the real dataset
npm run data:verify-tools  # the four questions above, through the tool layer, no model calls
npm run models             # list the models your API key can actually use
```

`data:verify-tools` is the quickest way to watch the deterministic core work without spending any
API quota.

---

## Data

| Source | Coverage |
|---|---|
| BTS T-100 Segment (all carriers) | 2019, 2023, 2024 — passengers, seats, departures, distance, freight |
| BTS On-Time Performance | All 12 months of 2024 — delay minutes with cause attribution |

~390 MB of raw government files are reduced offline to a **5.8 MB SQLite database** that is
committed and deployed with the app. The application never parses a CSV.

Rebuilding from source is optional, and needs Python 3 with pandas:

```bash
pip install pandas
npm run data:download    # pulls from BTS, ~10 minutes, ~390 MB
npm run data:build       # -> data/aviation.db
```

---

## Project layout

```
lib/scoring/      deterministic scoring engine — percentiles, cohorts, robustness
lib/tools/        six typed tools; assumptions travel as data, not prose
lib/agent/        bounded tool-calling loop, tool schemas, system prompt
lib/data/         read-only SQLite access (the only file that knows the storage format)
lib/analytics/    conversation recording, topic classification, cost accounting
app/api/chat/     chat endpoint (Node runtime — node:sqlite is unavailable on Edge)
app/page.tsx      chat UI with the tool trace panel
app/analytics/    the analytics dashboard
scripts/          Python data pipeline + TypeScript verification scripts
docs/             design documentation
```

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind 4 · `node:sqlite` (no native module) ·
Groq for inference · Python + pandas for offline data preparation only
