# Data Architecture

How data gets in, how it becomes one shape, how we avoid missing what we don't know we're missing,
and which entities we model.

---

## 1. Sources we don't have an API for

Public aviation data covers volume and punctuality well. It does not cover most of what actually
decides whether a terminal expansion pays back:

| Needed to decide "expand this terminal" | Availability |
|---|---|
| Passenger and seat volume, delays | ✅ BTS, mandatory carrier filings |
| Runway count and geometry | ✅ FAA facility data |
| **Gate counts and gate utilisation** | ⚠️ Airport master plans — PDFs, per-airport |
| **Slot allocations and curfews** | ⚠️ FAA orders, local ordinances, court settlements |
| **Available land for expansion** | ⚠️ Master plans, zoning records |
| **Capital improvement plans** | ⚠️ Airport websites, FAA grant records |
| **Construction cost, financing terms** | ❌ Not public |
| **Local political / environmental risk** | ❌ News, environmental filings — unstructured |

So scraping isn't an edge case, it's the normal path for the second tier. The architecture treats it
as such.

### Every source is an adapter behind one contract

```
fetch() → parse() → normalise() → validate() → emit(records + provenance)
```

An API client, a bulk CSV download, and an HTML scraper all implement the same interface. A scraper
is not a special kind of thing; it's an adapter whose `parse()` step is unusually fragile. Isolating
fragility behind a stable contract means a broken scraper degrades one input rather than breaking
the pipeline.

### Provenance travels with every record

```ts
interface Provenance {
  source: string;          // "BTS T-100 Segment (All Carriers)"
  method: "api" | "bulk_file" | "scrape" | "manual";
  sourceUrl: string;
  retrievedAt: string;     // ISO timestamp
  parserVersion: string;   // so a parser bug can be scoped to affected records
  confidence: ConfidenceTier;
}
```

### Confidence tiers, and the rule that matters

1. **Mandatory regulatory filings** — T-100, On-Time Performance. Carriers are legally required to
   report.
2. **Published official datasets** — FAA facility and runway data.
3. **Scraped structured pages** — tables with stable selectors.
4. **Scraped documents** — master-plan PDFs. Layout-dependent, breaks silently.
5. **Model-extracted from prose** — lowest. Always retains the source quote.

**The rule: a lower tier may never silently override a higher one.** If a scraped gate count
contradicts an official figure, that's a surfaced conflict, not a quiet overwrite. In a regulated
setting — a bank's Data + AI division, say — provenance and auditability are compliance
requirements, not niceties. "Where did this number come from?" must have an answer.

### The scoring engine already tolerates partial data

This isn't aspirational. `scoreAirports` handles a missing component by redistributing its weight
across the available ones and recording `unavailableReason` on the result. An airport with no delay
data is not penalised for our gap — and the omission is visible rather than hidden. Adding a
scraped source that covers 60% of airports therefore degrades gracefully by construction.

---

## 2. Loading and unifying

Four layers, each with one job:

```
raw/         exactly as downloaded. Immutable. Checksum + retrieval timestamp.
staging/     parsed and typed. One table per source. No joins yet.
conformed/   canonical entities and facts, joined on surrogate keys.
marts/       query-ready aggregates the application reads.
```

**`raw` is never edited.** When a parser bug is found — and one will be — you re-derive from raw
rather than re-download and hope the source hasn't changed underneath you. This is what makes the
pipeline reproducible.

### The join-key problem is the actual work

Airports carry at least five identifiers, and they do not map one-to-one:

- **IATA** — 3 letters (`SFO`). Reused across history.
- **ICAO** — 4 letters (`KSFO`).
- **FAA LID** — US-local identifier, sometimes but not always equal to IATA.
- **BTS `AIRPORT_ID`** — numeric, stable per airport.
- **BTS `AIRPORT_SEQ_ID`** — numeric, changes **when an airport's attributes change.**

That last one is the tell: BTS created a sequence ID precisely because airport attributes are not
static, and a naive join on a code silently mixes an airport's past and present.

**Solution:** a conformed `dim_airport` with a surrogate key, plus an `airport_crosswalk` table
mapping every external identifier to it. All sources join through the crosswalk. Nothing joins on a
raw code.

**Measured on our data:** 1,936 distinct origin codes in 2024, and **zero** codes mapping to more
than one city name — so IATA is clean *within* a single year. Cross-year stability is the untested
risk, and we hold three years, so the crosswalk earns its place rather than being ceremony.

### Grain discipline

Every table declares its grain and **asserts** it with a uniqueness constraint:

| Table | Grain |
|---|---|
| `fact_segment` | carrier × origin × dest × aircraft type × service class × month |
| `fact_ontime` | one scheduled flight |
| `airport_year` | airport × year |
| `route_year` | origin × dest × year |

Silent row duplication after a join is the single most common cause of confidently wrong numbers.
An unenforced grain is a bug waiting for a demo.

### Validation gates between layers

Row counts against expectation, null-rate thresholds, referential integrity, and domain assertions
— including the one already implemented: BTS defines service classes `K`, `V` and `Z` as
**aggregates** of other classes, so their presence alongside their components would double-count.
The build asserts they're absent rather than trusting it.

Loads are **idempotent**: full refresh, since the conformed dataset is ~5 MB. Re-running produces
identical output.

---

## 3. Not missing what you don't know you're missing

The hardest of the four questions. Nine practices, ordered by how much they've actually caught:

**1. Work backwards from the decision, not forwards from the data.**
Write down what an analyst needs to approve a terminal expansion, *then* mark what you have. The
gaps become explicit instead of invisible. This is how the profitability boundary was found — the
brief asks for profitability, and working backwards showed cost and financing data simply isn't
public.

**2. Read how professionals define the thing.**
The FAA publishes airport capacity methodology; ACRP research reports exist. Industry practice
surfaces dimensions you would never invent: runway geometry, capacity under instrument vs. visual
conditions, fleet mix, taxiway layout, gate utilisation, perimeter rules, noise budgets.

**3. Check your metric's distribution before trusting it.**
Already caught one: fewer flights with bigger aircraft looked like a constraint signal, but the
median US airport upgauged 12.5% while losing 2.8% of departures between 2019 and 2024. It was an
industry-wide fleet shift. Absolute thresholds would have flagged the whole industry as
constrained.

**4. Always ask "compared to what?"**
Produced the cohort design. The highest US load factors belong to Harrisburg (86.8%) and
Chattanooga (86.5%), not Atlanta (84.7%, 274 routes). Ranking without peer groups is meaningless.

**5. Validate against known answers.**
The FAA *publishes* which airports are slot-controlled. If the model doesn't rank known
slot-constrained airports highly, the model is wrong. That's a free external validation set, and
building it is a to-do.

**6. Hunt for constraints that are legal rather than physical.**
The worked example is live in this assignment. **Santa Ana (SNA) operates under a noise-abatement
curfew and a negotiated cap on annual passengers and daily departures.** Its capacity limit is a
legal instrument, not a runway. Load factor at 80.2% captures none of that — an airport can be
absolutely capacity-capped while looking unremarkable on every metric we compute. Long Beach (LGB)
is the same class of case.

This matters directly: "compare LA and Santa Ana congestion" is one of the four sample questions,
and the honest answer involves a constraint that isn't in any dataset we hold. *(Specific current
figures need verifying against the airport's published access plan.)*

**7. Adversarial self-review.**
"What would score high here and still be a bad investment?" High demand with no available land,
hostile local politics, or a competitor thirty miles away with spare capacity.

**8. Sensitivity analysis.**
Vary the weights and see whether the ranking holds. If it swings wildly, the model is
under-determined and the product should say so rather than present one ordering as fact.

**9. Inspect the extremes and the residuals.**
Read the top and bottom of every ranking and ask whether it's plausible. Harrisburg ranking first
was caught exactly this way, as was New Haven's +1,110% growth.

---

## 4. Entities we model

### Dimensions

| Entity | Notes |
|---|---|
| **`dim_airport`** | Slowly changing — hub class and runway counts move over time. Type-2 history if we care when. |
| **`dim_carrier`** | Codes are **reused across years**; BTS disambiguates with suffixes (`PA`, `PA(1)`, `PA(2)`). Zero suffixed codes appear in 2024, but multi-year joins are exposed. |
| **`dim_aircraft_type`** | 171 distinct codes in 2024. **Currently unused** — would enable body-type and gauge analysis. |
| **`dim_service_class`** | The `A/C/E/F/G/L/P` dimension. Already central to the build. |
| **`dim_date`** | Year and month. |
| **`dim_metro` / `dim_region`** | Airport groupings. Defined in `lib/scoring/config.ts`. |

### Facts

`fact_segment` (T-100) and `fact_ontime` (On-Time Performance), at the grains declared above.

### Bridges

`airport_metro_bridge` — deliberately many-to-many. Metro definitions overlap and are contested;
Santa Ana belongs to Greater Los Angeles under any sensible definition, which is exactly what makes
the sample question ambiguous.

### Cargo is not an airline attribute — measured, not assumed

The intuitive model is a `is_cargo_airline` flag. The data says that's wrong.

**2024 carrier classification (305 carriers):**

| Type | Count |
|---|---|
| All-cargo operators | 45 |
| **Mixed — both passenger and cargo operations** | **48** |
| Passenger-only operators | 136 |

**And freight moves on passenger aircraft:**

| | Freight (lbs) |
|---|---|
| On all-cargo segments | 43,642,969,866 |
| **On scheduled passenger segments** | **9,376,140,420** |

**17.7% of all air freight rides in the belly of passenger aircraft.** United alone moved
1.56 billion pounds on passenger flights; American 0.99 billion; Delta 0.97 billion.

**Therefore:** cargo is a **segment-level fact** (via service class), with `operator_type` as a
*derived* carrier attribute — never the primary model. Treating "cargo airline" as an airline
property would misattribute 9.4 billion pounds of freight and quietly understate cargo activity at
every major passenger hub.

The top all-cargo operators, for reference: FX (FedEx) 12.1bn lbs, 5X (UPS) 8.9bn, 5Y (Atlas Air)
4.6bn — which is also why Memphis, Louisville and Anchorage top the freight rankings.
