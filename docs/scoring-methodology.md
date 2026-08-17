# The Scoring Model, From Scratch

No jargon assumed. Read this before defending anything else.

---

## Part 0 — What "NAS delay per arrival" means

**NAS** = **National Airspace System**. It is one of five delay-cause buckets.

When a US flight arrives 15 or more minutes late, the airline is legally required to report *why*,
split across exactly five categories:

| Cause | Meaning | Whose problem? |
|---|---|---|
| **Carrier delay** | Maintenance, crew, baggage, fuelling | The airline's |
| **Late aircraft delay** | The aircraft arrived late from its previous flight | Knock-on from elsewhere |
| **NAS delay** | Air traffic control, traffic volume, airport operations, non-extreme weather | **The airport and its airspace** |
| **Weather delay** | Extreme weather — storms that stop flying | Nature |
| **Security delay** | Screening problems | Security |

So **NAS delay is the minutes of lateness blamed on the airport/airspace system itself**, rather
than on the airline. That is why it's the one we use: it is the closest thing in public data to
"this airport could not handle the traffic it had".

**"Per arrival"** means: total NAS delay minutes at that airport over the whole year, divided by the
number of flights that arrived there.

- **SFO = 7.98** → on average, *every* flight landing at San Francisco absorbed about 8 minutes of
  delay attributable to airport/airspace capacity. That average includes all the perfectly on-time
  flights, which is why a figure of 8 is high.
- Divided **per arrival** because a big airport naturally accumulates more total delay minutes
  simply by having more flights. Dividing makes airports comparable.
- **Arrivals**, not departures, because BTS attributes the cause to the *arriving* flight. Using
  departures as the denominator would misalign numerator and denominator.

---

## Part 1 — What question can this data actually answer?

The brief asks where renovation will be **most profitable**. Profit is:

```
revenue from extra passengers  −  construction cost  −  financing cost
```

**We have no data on the entire right-hand side.** Construction costs, financing terms, concession
revenue and lease structures are not public. Anyone who claims to rank profitability from flight
data is guessing.

What flight data *can* answer is the left side:

> **Where is there passenger demand that the airport's current physical capacity cannot serve?**

That is a **demand-side opportunity score**. Saying so plainly is not a weakness in the answer — it
is the answer. State the boundary, then work rigorously inside it.

---

## Part 2 — What does "capacity can't serve demand" look like in data?

Think of an airport as a pipe and demand as water. If demand exceeds what the pipe can carry, four
things become observable. Each is a **symptom**, and each has a weakness — which is exactly why we
use four rather than one.

### Symptom 1 — The planes are full

**Measure:** load factor = passengers ÷ available seats.
**Examples:** EWR 85.5%, LAX 84.4%, SFO 83.2%, SNA 80.2%, BUR 73.4%.

**Why it indicates constraint:** at 85%+, an airline physically cannot seat more passengers without
larger aircraft or more flights.

**Its weakness:** airlines *manage* load factor deliberately — around 85% is their revenue target,
not an accident. High load factor can mean good pricing rather than scarcity. And small airports hit
high load factors trivially: the highest in the country are Harrisburg (86.8%) and Chattanooga
(86.5%), ahead of Atlanta (84.7%).

### Symptom 2 — Flights are chronically late *for airport reasons*

**Measure:** NAS delay minutes per arrival (Part 0).
**Examples:** SFO 7.98, EWR 6.68, BOS 4.48, LAX 2.04, ONT 0.99.

**Why it indicates constraint:** it is the most direct evidence that physical limits are being hit
*today*. Aircraft queue because the airport cannot process them faster.

**Its weakness:** covers only larger reporting carriers, so 195 of our 728 airports have usable
figures. And delay driven by weather may reflect climate rather than a fixable building.

### Symptom 3 — Demand is still growing

**Measure:** passenger growth, blended from 2019→2024 (structural) and 2023→2024 (recent).
**Examples:** SJU +23.7%, MIA +15.1%, BOS +4.7%, SFO −2.0%, MHT −12.7%.

**Why it matters:** an airport can be constrained *and shrinking* — in which case don't invest.
Expansion pays back over decades, so the trend matters more than the snapshot.

**Its weakness:** COVID wrecks comparisons (we skip 2020–21 entirely), and growth rates from a small
base are meaningless — New Haven shows +510% because one airline opened a base there.

### Symptom 4 — Airlines add seats with bigger planes instead of more flights

This is the subtle one, and the most interesting.

**The logic:** if an airline wants to carry more people and it *can* add flights, it adds flights —
more departure times are more attractive to passengers and use aircraft better. If it **cannot** get
more takeoff/landing permissions or gates, its only remaining option is to fly **bigger aircraft on
the same number of flights**. The industry word is **upgauging**.

So upgauging is **revealed preference**: the airline is effectively telling you it couldn't add
flights.

**Measure:** seat growth minus departure growth, in percentage points.

**Its weakness — and this one nearly broke the model.** Between 2019 and 2024 the median US airport
upgauged **12.5%** while *losing* **2.8%** of departures. The whole industry did this, because US
carriers retired regional jets and shifted to mainline aircraft. That is a fleet decision made at
airline headquarters, not evidence about any airport.

**The fix:** measure it **relative to peers**, never absolutely. The question becomes "is this
airport upgauging *more than comparable airports*?" Measured absolutely, this metric would have
flagged nearly the entire industry as capacity-constrained.

---

## Part 3 — Why you cannot just add the four together

The four measurements are in incompatible units:

```
load factor        83.2  percent
NAS delay           7.98 minutes
growth             −2.0  percent
upgauging           6.38 percentage points
```

`83.2 + 7.98 + (−2.0) + 6.38` is meaningless arithmetic. Percent and minutes don't add.

---

## Part 4 — So convert each to a rank (percentile)

For each symptom, ask instead: **"where does this airport sit among comparable airports, on a scale
of 0 to 100?"**

SFO's load factor of 83.2% puts it at the **79th percentile** among large hubs — higher than 79% of
its peers. Now every symptom is on the same 0–100 scale and *can* be combined.

Percentiles also solve the outlier problem. New Haven's +510% growth becomes "100th percentile —
the highest" rather than "eleven times more important than second place". Under raw values or
z-scores, one freak number dominates the entire result.

---

## Part 5 — Compared to *whom*? (cohorts)

Ranking Atlanta against Harrisburg is meaningless. So airports are grouped by size first, and ranked
**only within their group**. We use the FAA's hub classes, computed from share of national
passengers:

| Cohort | Share of national passengers | Count in our data |
|---|---|---|
| Large hub | ≥ 1% | 31 |
| Medium hub | 0.25% – 1% | 35 |
| Small hub | 0.05% – 0.25% | 74 |

**Proof this was necessary:** without cohorts, Harrisburg's 86.8% load factor beats Atlanta's 84.7%,
and Harrisburg becomes the top terminal-expansion candidate in America. That is obviously wrong, and
it is what raw ranking produces.

**Critical consequence:** scores are **only comparable within a cohort**. A medium hub scoring 97
and a large hub scoring 83 are not ranked against each other — their percentiles were computed
against different populations. Cross-cohort "overall" rankings should not be produced at all.

---

## Part 6 — Weighting, and the honest status of the weights

Not every symptom is equally informative, so each gets a weight:

| Component | Weight | Why this weight |
|---|---|---|
| Demand pressure | **0.35** | Most direct evidence that existing capacity is being consumed |
| Capacity strain | **0.25** | Confirms the constraint is real *today*, not theoretical |
| Growth momentum | **0.25** | Expansion only pays back if demand keeps rising |
| Frequency constraint | **0.15** | Most distinctive signal, but most indirect — fleet decisions confound it |

**These are judgement calls, not measurements.** They live in one visible config file so a reviewer
can challenge the whole value system at once, and they can be overridden per request.

**They are not calibrated.** Calibration would require a labelled dataset of past airport expansion
projects and their realised returns. No such public dataset exists. So the weights are a defensible
starting prior — and saying that is more credible than pretending otherwise.

---

## Part 7 — The formula

```
score = Σ (percentile_within_cohort(component) × weight(component))
```

Bounded 0–100. Fully deterministic: same inputs and weights always give the same output. No language
model touches this calculation.

If a component is unavailable — no delay data, say — its weight is redistributed across the
remaining components, and the result records *why* it was unavailable. Otherwise an airport would be
penalised for a gap in **our data** rather than for anything about the airport.

---

## Part 8 — Worked example: SFO

| Component | Raw value | Percentile (of 31 large hubs) | Weight | Contribution |
|---|---|---|---|---|
| Demand pressure | 83.2% load factor | 79.0 | 0.35 | **27.7** |
| Capacity strain | 7.98 NAS min/arrival | **98.4** | 0.25 | **24.6** |
| Growth momentum | −2.0% | **11.3** | 0.25 | **2.8** |
| Frequency constraint | +6.38 pts | 30.6 | 0.15 | **4.6** |
| | | | | **59.7** |

**How to read this — and the total is the least interesting part.**

SFO is the **most operationally strained large hub in the United States** (98.4th percentile) while
**shrinking** (11.3th percentile — passengers are still below 2019). Those two facts together mean
something specific:

> SFO's problem is not that demand exceeds seats. It is that the airport **cannot reliably land
> aircraft** for roughly a third of the year. NAS delay swings 6.2x seasonally — 16.75 minutes per
> arrival in April against 2.70 in July — while *extreme-weather* delay stays flat. That pattern is
> throughput reduction, not storms: SFO's two main parallel runways are too closely spaced for
> independent approaches in poor visibility, so the arrival rate roughly halves in the Bay Area's
> winter–spring rain season.

**Investment implication:** more terminal space would not fix SFO. The binding constraint is runway
geometry — vastly more expensive and politically harder, since expansion means building into the bay.

That conclusion comes from reading the *components*, not the total. It is why the product exposes
component breakdowns rather than just a number.

---

## Part 9 — Sensitivity: how stable is the ranking?

Top 6 large hubs under different weightings:

| Weighting | Result |
|---|---|
| Default | MIA, DFW, EWR, CLT, LGA, MCO |
| Demand only | EWR, ATL, LAX, MIA, DFW, SEA |
| Strain only | **SFO**, EWR, FLL, BOS, MCO, LGA |
| Growth only | BNA, MIA, CLT, DFW, DEN, PHX |
| Equal weights | MIA, DFW, CLT, EWR, DEN, IAH |

**Only Miami and Dallas–Fort Worth appear in every variant.** The rest of the ordering moves
substantially with the weights.

**This must be disclosed, not hidden.** The honest statement is: *"Miami and DFW are robust picks
across any reasonable weighting. Beyond those, the ranking depends on which symptom you privilege,
and here is how it changes."* Presenting one ordering as fact would overstate what the model knows.

---

## Part 10 — What this score is NOT

- **Not a profitability prediction.** No cost data exists in it.
- **Not comparable across cohorts.** Percentiles are computed within size groups.
- **Not validated against outcomes.** No public dataset links expansion projects to returns.
- **Blind to legal constraints.** Santa Ana operates under a noise curfew and a negotiated cap on
  passengers and daily departures. It can be absolutely capacity-capped while looking unremarkable
  on every metric here. Long Beach is the same case.
- **Blind to land, politics and cost.** An airport can score high and be unbuildable.
- **Delay-blind for 533 of 728 airports**, which are not covered by the On-Time dataset.

Naming these is part of the deliverable. The brief explicitly asks for assumptions, uncertainty and
scoping to be communicated — and a model whose limits are stated is more trustworthy than one
presented as complete.
