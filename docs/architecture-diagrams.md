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
        CHARTS["Generative UI<br/><i>app/chat-charts.tsx</i><br/>tool name picks the component"]
    end

    subgraph server["Next.js server — Node runtime"]
        API["POST /api/chat<br/><i>request validation</i>"]
        AGENT["Agent loop<br/><i>max 3 iterations</i>"]
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

        REC["Analytics recorder<br/><i>Next.js after hook</i><br/>runs once the reply is sent"]
        ADB[("analytics.db<br/><i>SQLite or Turso</i>")]
    end

    LLM["Groq<br/><i>openai/gpt-oss-120b</i><br/><b>routes and narrates only</b>"]

    UI -->|"messages[] + signed session token"| API
    API --> AGENT
    AGENT <-->|"tool calls"| LLM
    AGENT --> DISPATCH
    DISPATCH --> tools
    tools --> core
    core --> DB
    tools --> DB
    AGENT -->|"reply + trace + tool payloads"| UI
    UI --> TRACE
    UI --> CHARTS

    API -.->|"off the critical path"| REC
    REC --> ADB
    ADB --> DASH["Dashboard<br/><i>/analytics</i>"]

    style LLM fill:#fff3cd,stroke:#856404,color:#000
    style core fill:#d4edda,stroke:#155724,color:#000
    style DB fill:#d1ecf1,stroke:#0c5460,color:#000
    style ADB fill:#d1ecf1,stroke:#0c5460,color:#000
    style CHARTS fill:#d4edda,stroke:#155724,color:#000
    style REC fill:#e2e3e5,stroke:#383d41,color:#000
```

**Reading the colours:** green is deterministic and unit-tested; amber is the only
non-deterministic component; blue is data at rest. Notice that no arrow runs from the amber box
into the green one — the model cannot reach the calculation.

The same holds for the charts. The model selects a tool; the tool's typed result travels to the
browser; the tool's NAME selects a component, which renders that result verbatim. Which figures
appear in an answer is generated per turn — what they say is not. No arrow runs from the amber box
to the charts either.

**The recorder hangs off a dashed arrow on purpose.** It runs after the reply has already been
sent, so measurement cannot slow down or fail an answer — the worst case for a broken analytics
write is a missing row, never a failed question. Diagram 7 covers what it records.

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
        R4["Seat growth − departure growth<br/><i>6.27 points</i>"]
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
    participant R as Analytics recorder

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

    A->>A: check the reply relayed every mustMention
    Note over A: measured, not assumed —<br/>a relay rate ships with the response

    A-->>U: reply + tool trace + relay rate

    A->>R: record the turn (after the reply is sent)
    Note over R: never blocks the answer

    Note over U,D: Every figure in the reply came from a tool result.<br/>The trace panel makes that auditable.
```

---

## 5. Required context — asking, then checking

The brief asks the agent to communicate assumption, uncertainty and scoping. A prompt that *asks*
for caveats gets them filtered: told that caveats were "worth including where they matter", the
model dropped Anchorage's freight note — 5.75 billion pounds of cargo against 2.66 million
passengers, which is the single most important thing about reading that airport's passenger
figures.

So context that an answer is wrong without travels as a **field on the tool result**, and the reply
is checked against it afterwards.

```mermaid
flowchart TB
    subgraph tools["Tools return mustMention as data"]
        M1["getAirportMetrics<br/><i>key: freight:ANC</i>"]
        M2["compareAirports<br/><i>key: metro:los_angeles</i>"]
        M3["rankAirports<br/><i>key: cohort:mixed</i>"]
    end

    DEDUP["Resolve<br/><i>dedup by key, sort by priority</i>"]
    PROMPT["Injected as REQUIRED context<br/><i>not as a suggestion</i>"]
    REPLY["Model writes the answer"]
    CHECK{"Did the reply actually<br/>relay each one?"}
    RATE["relayRate ships on the response<br/><i>and the trace panel</i>"]

    M1 --> DEDUP
    M2 --> DEDUP
    M3 --> DEDUP
    DEDUP --> PROMPT --> REPLY --> CHECK --> RATE

    style tools fill:#d4edda,stroke:#155724,color:#000
    style REPLY fill:#fff3cd,stroke:#856404,color:#000
    style CHECK fill:#d1ecf1,stroke:#0c5460,color:#000
```

**Two decisions worth defending.**

*The fact is attached to the airport, not to one tool.* The first version emitted the metro
relationship only from `compareAirports` — then the model answered "compare LA and Santa Ana" with
`resolveAirport` plus two `getAirportMetrics` calls, never touched `compareAirports`, and compared
the two airports without ever saying they share a catchment area. Every tool that returns an
airport now emits it, and the `key` collapses the duplicates.

*Asking without checking is still only persuasion.* `checkRelayed` looks for each item's distinctive
signals — figures, airport codes — in the finished reply, and the relay rate is returned with the
answer. That turns a hope about prompt-following into a number that would show up in the analytics
if it regressed.

---

## 6. Ambiguity handling

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

## 7. Conversation analytics

Recording what was asked, what it cost, how long it took, and what it was *about*. All of it runs
after the reply has been sent, so the measurement can never delay or fail the thing it measures.

```mermaid
flowchart TB
    TURN["A completed turn<br/><i>prompt, reply, trace, usage, timing</i>"]

    subgraph extract["Two dimensions of what was asked"]
        direction LR

        subgraph det["Entities — deterministic"]
            E1["Match IATA codes and city names<br/><i>against the airport table</i>"]
            E2["ANC · SFO · 'Anchorage'"]
        end

        subgraph llm["Topic — genuinely fuzzy"]
            C1{"Rules match?"}
            C2["Keyword rules<br/><i>free, instant</i>"]
            C3["Small model fallback<br/><i>openai/gpt-oss-20b</i>"]
        end
    end

    ADB[("analytics.db<br/><i>SQLite locally,<br/>Turso deployed</i>")]
    DASH["/analytics dashboard<br/><i>cost · latency · tokens ·<br/>topics · airports · reliability</i>"]

    TURN --> E1 --> E2 --> ADB
    TURN --> C1
    C1 -->|yes| C2 --> ADB
    C1 -->|no| C3 --> ADB
    ADB --> DASH

    style det fill:#d4edda,stroke:#155724,color:#000
    style llm fill:#fff3cd,stroke:#856404,color:#000
    style ADB fill:#d1ecf1,stroke:#0c5460,color:#000
```

**The same green/amber boundary as everywhere else in this system.** Recognising that "Anchorage"
and "ANC" mean the same airport is a lookup against a table the app already has — there is no
reason for a language model to decide whether ANC is an airport, and a deterministic answer is free,
instant and cannot drift. Topic is the genuinely ambiguous part, so it gets rules first and a small
model only when the rules abstain. The classifier is deliberately *not* the model that answers
questions: it is cheaper, and it keeps six months of topic history from shifting when the chat model
is swapped.

**Why the session id is signed.** `turn_id` is derived from it and the write is an upsert, so
accepting any well-formed id from the browser would let a caller name — and therefore overwrite —
another conversation's recorded turn. The server mints a signed token and ignores anything it did
not sign. Validation degrades rather than rejects: an unrecognised token earns a fresh session
instead of failing the request, because refusing to answer a question over a bad telemetry label
would invert the priority between the product and the measurement of it.

---

## 8. Where the boundary sits

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
