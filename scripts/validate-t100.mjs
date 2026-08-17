// Phase 0 validation: confirm the T-100 export is real, current, and sufficient
// for the Expansion Opportunity Score. Throwaway script — proves the data before we build on it.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
console.log("files in export:", files);

const dataFile = files.find((f) => !/documentation/i.test(f));
if (!dataFile) throw new Error("no data CSV found");
const full = path.join(dir, dataFile);
console.log(`\ndata file: ${dataFile}  (${(fs.statSync(full).size / 1024 / 1024).toFixed(2)} MB)\n`);

const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity });

let header = null;
let idx = {};
let rows = 0;
const years = new Set();
const months = new Set();
const classes = new Set();

// aggregation buckets
const byAirport = new Map(); // origin -> {pax, seats, deps, freightRows}
const ancHaul = { pax: 0, long: 0, med: 0, short: 0, cargoRows: 0 };

// naive CSV splitter that respects double quotes — adequate for BTS output
function split(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

for await (const line of rl) {
  if (!line.trim()) continue;
  if (!header) {
    header = split(line).map((h) => h.replace(/"/g, "").trim());
    header.forEach((h, i) => (idx[h] = i));
    console.log("COLUMNS:", header.filter(Boolean).join(", "), "\n");
    continue;
  }
  const c = split(line);
  rows++;
  years.add(c[idx.YEAR]);
  months.add(c[idx.MONTH]);
  const cls = c[idx.CLASS];
  classes.add(cls);

  const origin = c[idx.ORIGIN];
  const pax = Number(c[idx.PASSENGERS]) || 0;
  const seats = Number(c[idx.SEATS]) || 0;
  const deps = Number(c[idx.DEPARTURES_PERFORMED]) || 0;
  const dist = Number(c[idx.DISTANCE]) || 0;

  // CLASS F = scheduled passenger service (domestic). Everything else is charter/cargo/etc.
  if (cls === "F") {
    let a = byAirport.get(origin);
    if (!a) byAirport.set(origin, (a = { pax: 0, seats: 0, deps: 0 }));
    a.pax += pax;
    a.seats += seats;
    a.deps += deps;
  }

  if (origin === "ANC") {
    if (cls === "F") {
      ancHaul.pax += pax;
      if (dist >= 2400) ancHaul.long += pax;
      else if (dist >= 800) ancHaul.med += pax;
      else ancHaul.short += pax;
    } else if (seats === 0 && pax === 0) {
      ancHaul.cargoRows++;
    }
  }
}

const n = (x) => x.toLocaleString("en-US");
console.log(`rows: ${n(rows)}`);
console.log(`years: ${[...years].join(", ")}`);
console.log(`months: ${[...months].sort((a, b) => a - b).join(", ")}`);
console.log(`service classes present: ${[...classes].sort().join(", ")}`);

console.log("\n--- Load factor, scheduled passenger service (CLASS F), 2024 ---");
for (const code of ["SFO", "LAX", "SNA", "BOS", "JFK", "ANC", "ATL"]) {
  const a = byAirport.get(code);
  if (!a) { console.log(`  ${code}: no rows`); continue; }
  const lf = a.seats ? (a.pax / a.seats) * 100 : 0;
  const spd = a.deps ? a.seats / a.deps : 0;
  console.log(
    `  ${code}:  pax=${n(a.pax).padStart(11)}  seats=${n(a.seats).padStart(11)}  deps=${n(a.deps).padStart(8)}  LF=${lf.toFixed(1)}%  seats/dep=${spd.toFixed(0)}`
  );
}

console.log("\n--- Anchorage haul mix (passenger service, by great-circle distance band) ---");
if (ancHaul.pax) {
  const p = (x) => ((x / ancHaul.pax) * 100).toFixed(1) + "%";
  console.log(`  total pax: ${n(ancHaul.pax)}`);
  console.log(`  long-haul (>=2400mi):  ${p(ancHaul.long)}`);
  console.log(`  medium  (800-2400mi):  ${p(ancHaul.med)}`);
  console.log(`  short   (<800mi):      ${p(ancHaul.short)}`);
  console.log(`  non-passenger-service rows out of ANC (cargo/charter): ${n(ancHaul.cargoRows)}`);
}

console.log(`\ndistinct origin airports with scheduled passenger service: ${n(byAirport.size)}`);
