// Run: node tests/engine.test.mjs
// Checks model math (credit conserves conversions) and that the collateral
// lift recovers the effects planted by the generator (tests/truth.json).
import { readFileSync } from "node:fs";
import { createEngine, STAGES, MODELS } from "../docs/js/engine.js";

const raw = JSON.parse(readFileSync(new URL("../docs/data/acme.json", import.meta.url)));
const truth = JSON.parse(readFileSync(new URL("./truth.json", import.meta.url)));
const E = createEngine(raw);
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures++;
};

// 1. Every model conserves credit for every stage
for (const s of STAGES) {
  for (const m of MODELS) {
    const r = E.attribute({ stage: s.id, model: m.id });
    const credit = r.channels.reduce((a, c) => a + c.credit, 0);
    const expected = r.conversions - r.unattributed;
    if (Math.abs(credit - expected) > 1e-6 * Math.max(1, expected)) check(false, `${m.id}/${s.id} credit ${credit} != ${expected}`);
  }
}
check(true, "credit sums to attributed conversions for all models x stages");

// 2. Lift recovers planted asset effects (direction) where data is sufficient
const L = E.lift();
let agree = 0, total = 0;
const rows = [];
for (const s of STAGES) {
  for (const r of L[s.id]) {
    if (!r.enough || !r.sig) continue;
    const t = truth.asset_effects[r.asset][s.id] ?? 1.0;
    total++;
    const ok = (r.lift > 1) === (t > 1) || Math.abs(t - 1) < 0.15;
    if (ok) agree++;
    rows.push(`${r.asset} ${s.id.padEnd(9)} lift ${r.lift.toFixed(2)} z ${r.z.toFixed(1)}  truth ${t}${ok ? "" : "  <-- disagrees"}`);
  }
}
console.log(rows.join("\n"));
check(total >= 6 && agree / total >= 0.85, `significant lifts agree with planted effects: ${agree}/${total}`);

// 3. Strong planted effects are detected
const strong = [];
for (const [a, eff] of Object.entries(truth.asset_effects))
  for (const [s, v] of Object.entries(eff)) if (v >= 1.8) strong.push([a, s, v]);
let found = 0;
for (const [a, s, v] of strong) {
  const r = L[s].find((x) => x.asset === a);
  const hit = r.enough && r.lift > 1.15;
  if (hit) found++;
  else console.log(`  missed ${a} ${s} (truth ${v}) lift ${r.lift?.toFixed(2)} n ${r.touches} enough ${r.enough}`);
}
check(found / strong.length >= 0.7, `strong planted effects detected: ${found}/${strong.length}`);

// 4. Scorecard
console.log("\nScorecard:");
for (const a of E.scorecard()) console.log(`  ${a.id} ${a.status.padEnd(12)} reach ${String(a.contacts).padStart(4)}  best ${a.best ? a.best.stage + " " + a.best.lift.toFixed(2) : "-"}  ${a.name}`);

// 5. Markov shares sum to 1
const mk = E.markovEffects("sql", { lookbackDays: 365, useEventDate: false });
check(Math.abs(mk.share.reduce((a, b) => a + b, 0) - 1) < 1e-9, `markov shares sum to 1 (base conv prob ${mk.base.toFixed(3)})`);

console.log("\nSuggestions:");
for (const s of E.suggestions({})) console.log(`  [${s.severity}] ${s.title}`);
console.log("\nKPIs", E.kpis());
console.log("Hygiene", JSON.stringify(E.hygiene({}), null, 0));

process.exit(failures ? 1 : 0);
