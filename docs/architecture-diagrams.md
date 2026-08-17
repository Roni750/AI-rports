# Architecture Diagrams

Companion to [`../DESIGN.md`](../DESIGN.md). Every diagram here renders natively on GitHub.

---

## 1. System overview

The central claim of this design: **the language model computes nothing.** It selects a tool,
passes parameters, and narrates what comes back. Every number in every answer originates below the
tool boundary.

```mermaid
flowchart TB
    subgraph browser["Browser"]
        UI["Chat UI<br/><i>app/page.tsx</i>"]
        TRACE["Tool trace panel<br/><i>shows every call</i>"]
    end

    subgraph server["Next.js server — Node runtime"]
        API["POST /api/chat<br/><i>request validation</i>"]
        AGENT["Agent loop<br/><i>max 6 iterations</i>"]
        DISPATCH["Tool dispatcher<br/><i>validates every parameter</i>"]

        subgraph tools["Tool surface — 6 typed tools"]
            T1["resolveAirport"]
            T2["getAirportMetrics"]
            T3["rankAirports"]
            T4["compareAirports"]
            T5["explainScore"]
            T6["flightMix"]
        end

        subgraph core["Deterministic core — no LLM"]
            SCORE["Scoring engine<br/><i>percentiles, cohorts, weights</i>"]
            ROBUST["Robustness check<br/><i>6 weightings</i>"]
        end

        DB[("SQLite<br/>5.8 MB<br/><i>committed</i>")]
    end

    LLM["Groq<br/><i>openai/gpt-oss-120b</i><br/><b>routes and narrates only</b>"]

    UI -->|"messages[]"| API
    API --> AGENT
    AGENT <-->|"tool calls"| LLM
    AGENT --> DISPATCH
    DISPATCH --> tools
    tools --> core
    core --> DB
    tools --> DB
    AGENT -->|"reply + trace"| UI
    UI --> TRACE

    style LLM fill:#fff3cd,stroke:#856404,color:#000
    style core fill:#d4edda,stroke:#155724,color:#000
    style DB fill:#d1ecf1,stroke:#0c5460,color:#000
```

**Reading the colours:** green is deterministic and unit-tested; amber is the only
non-deterministic component; blue is data at rest. Notice that no arrow runs from the amber box
into the green one — the model cannot reach the calculation.

---

## 2. Offline data pipeline

Runs once on a developer machine. ~390 MB of raw government files become a 5.8 MB database that is
committed to the repository and deployed with the app. The application never parses a CSV.

```mermaid
flowchart LR
    subgraph sources["Public sources"]
        T100["BTS T-100 Segment<br/><i>all carriers</i><br/>2019 · 2023 · 2024"]
        OT["BTS On-Time Performance<br/><i>12 months of 2024</i>"]
    end

    subgraph python["Python — offline, never deployed"]
        DL["download_data.py<br/><i>ASP.NET form POST</i>"]
        BUILD["build_dataset.py<br/><i>airport-year + route-year</i>"]
        DELAY["build_delays.py<br/><i>delay cause attribution</i>"]
    end

    RAW[("data/raw/<br/>~390 MB<br/><i>gitignored</i>")]
    DB[("data/aviation.db<br/>5.8 MB<br/><i>committed</i>")]

    T100 --> DL
    OT --> DL
    DL --> RAW
    RAW --> BUILD
    RAW --> DELAY
    BUILD --> DB
    DELAY --> DB
    DB --> APP["TypeScript app<br/><i>read-only</i>"]

    style python fill:#e2e3e5,stroke:#383d41,color:#000
    style DB fill:#d1ecf1,stroke:#0c5460,color:#000
    style RAW fill:#f8d7da,stroke:#721c24,color:#000
```

**Why pre-ingest rather than query live:** T-100 is published with a multi-month lag, so
per-request freshness buys nothing real while adding latency and a live failure mode. A demo that
dies on a rate limit is worse than a documented snapshot.

---

## 3. How a score is computed

Four components, each converted to a percentile **within the airport's size cohort**, then combined
as a weighted sum. The percentile step is what makes incompatible units — percent, minutes,
percentage points — addable at all.

```mermaid
flowchart TB
    subgraph raw["Raw measurements — incompatible units"]
        R1["Load factor<br/><i>83.2 percent</i>"]
        R2["NAS delay<br/><i>7.98 minutes/arrival</i>"]
        R3["Passenger growth<br/><i>−2.0 percent</i>"]
        R4["Seat growth − departure growth<br/><i>6.38 points</i>"]
    end

    COHORT{"Assign size cohort<br/><i>share of national passengers</i>"}

    subgraph pct["Percentile rank within cohort — 0-100"]
        P1["79.0"]
        P2["98.4"]
        P3["11.3"]
        P4["30.6"]
    end

    subgraph w["Weighted — weights live in config"]
        W1["× 0.30 = 23.7"]
        W2["× 0.25 = 24.6"]
        W3["× 0.25 = 2.8"]
        W4["× 0.20 = 6.1"]
    end

    SCORE["Score 57.3<br/><i>comparable only within cohort</i>"]
    ROBUST["Robustness note<br/><i>re-rank under 6 weightings</i>"]

    R1 --> COHORT
    R2 --> COHORT
    R3 --> COHORT
    R4 --> COHORT
    COHORT --> P1 --> W1 --> SCORE
    COHORT --> P2 --> W2 --> SCORE
    COHORT --> P3 --> W3 --> SCORE
    COHORT --> P4 --> W4 --> SCORE
    SCORE --> ROBUST

    style raw fill:#f8d7da,stroke:#721c24,color:#000
    style pct fill:#fff3cd,stroke:#856404,color:#000
    style SCORE fill:#d4edda,stroke:#155724,color:#000
```

Figures shown are San Francisco's actual 2024 values. Read the *components*, not the total: SFO is
the most delay-constrained large hub in the country (98.4th percentile) while shrinking (11.3th) —
a profile the single number 57.3 completely hides.

---

## 4. The agent loop

Structurally a workflow with one agentic segment. The model chooses which tools to call and in what
order; the tool set is fixed, every parameter is validated, and the loop is bounded. Constrained
systems are predictable, and for an investment tool predictability beats autonomy.

```mermaid
sequenceDiagram
    participant U as User
    participant A as Agent loop
    participant M as Model (Groq)
    participant T as Tool dispatcher
    participant D as SQLite

    U->>A: "Compare LA and Santa Ana congestion"
    A->>M: system prompt + 6 tool schemas + history

    rect rgb(255, 243, 205)
        Note over M: iteration 1 — model decides
        M-->>A: tool_use: resolveAirport("LA")
    end

    A->>T: dispatch + validate parameters
    T->>D: SELECT
    D-->>T: rows
    T-->>A: {ok, data, assumptions, mustMention}
    Note over A: result compacted<br/>numbers rounded, nulls dropped

    A->>M: tool result

    rect rgb(255, 243, 205)
        Note over M: iteration 2 — narrate only
        M-->>A: text answer
    end

    A-->>U: reply + tool trace

    Note over U,D: Every figure in the reply came from a tool result.<br/>The trace panel makes that auditable.
```

---

## 5. Ambiguity handling

The brief's "compare LA and Santa Ana" question is deliberately ambiguous twice over: *LA* could
mean one airport or five, **and Santa Ana is itself inside greater Los Angeles.** The system
surfaces that rather than silently picking one.

```mermaid
flowchart TB
    Q["User names a place"] --> META{"Is it a metro alias?<br/><i>'LA', 'the Bay Area'</i>"}

    META -->|yes| AMB["Return kind=ambiguous<br/><i>both readings, ask the user</i>"]
    META -->|no| EXACT{"Exact IATA code?"}

    EXACT -->|yes| RESOLVED["Resolve"]
    EXACT -->|no| MATCH{"How many matches?"}

    MATCH -->|one| RESOLVED
    MATCH -->|several| DOM{"Does the busiest dominate<br/>the runner-up 10×?"}

    DOM -->|"yes<br/><i>ANC 2.66m vs MRI 1,416</i>"| RESOLVED2["Resolve to busiest<br/><i>+ note the alternative</i>"]
    DOM -->|"no<br/><i>genuinely comparable</i>"| AMB

    RESOLVED --> METRO{"Does it belong to a metro<br/>with sibling airports?"}
    RESOLVED2 --> METRO
    METRO -->|yes| NOTE["Attach metro relationship<br/><i>SNA sits inside greater LA</i>"]
    METRO -->|no| DONE["Return"]
    NOTE --> DONE

    style AMB fill:#fff3cd,stroke:#856404,color:#000
    style DONE fill:#d4edda,stroke:#155724,color:#000
    style NOTE fill:#d1ecf1,stroke:#0c5460,color:#000
```

**The design rule:** ask when the answer depends on the user's *intent*; don't ask when one option
is obviously right. Making a user choose between Anchorage International and a general-aviation
field with 1,416 passengers is not care, it is obtuseness.

---

## 6. Where the boundary sits

What the system measures, and what it deliberately does not.

```mermaid
flowchart LR
    subgraph in["Measured — public data supports this"]
        I1["Passengers, seats, departures"]
        I2["Delay minutes and cause"]
        I3["Route-level load factors"]
        I4["Freight tonnage"]
        I5["Multi-year growth"]
    end

    SCORE["Demand-side<br/>expansion opportunity"]

    subgraph out["NOT measured — stated, not hidden"]
        O1["Construction cost"]
        O2["Financing terms"]
        O3["Land availability"]
        O4["Environmental and political risk"]
        O5["Legal caps<br/><i>SNA's noise curfew</i>"]
        O6["Concession revenue"]
    end

    PROFIT["Profitability<br/><i>what the brief asked for</i>"]

    in --> SCORE
    SCORE -.->|"insufficient alone"| PROFIT
    out -.->|"would also be required"| PROFIT

    style in fill:#d4edda,stroke:#155724,color:#000
    style out fill:#f8d7da,stroke:#721c24,color:#000
    style PROFIT fill:#e2e3e5,stroke:#383d41,color:#000
```

The brief asks which airports make renovation most *profitable*. Public aviation data cannot answer
that. It can rigorously answer the demand side, and naming the gap is part of the deliverable
rather than an admission against it.
