import { createEngine, STAGES, STAGE, MODELS, STATUS } from "./engine.js";
import { hbar, heatStyle, quadrant, bindTooltips, esc } from "./charts.js";
import { buildDeck } from "./deck.js";
import { startTour } from "./tour.js";

const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const fmtN = (v, d = 0) => (v == null || !isFinite(v) ? "–" : v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const fmt$ = (v) => {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e4) return "$" + Math.round(v / 1e3) + "K";
  return "$" + Math.round(v).toLocaleString("en-US");
};
const pct = (v, d = 0) => (v == null || !isFinite(v) ? "–" : (v * 100).toFixed(d) + "%");
const TABS = ["overview", "channels", "collateral", "journeys", "postsale", "optimization", "method"];

let E;
const state = { stage: "sql", model: "w_shaped", lookback: 365, period: "all", tab: "overview", statusFilter: "all", chSort: "sql", chAsc: false, asSort: "status", asAsc: true };
try { Object.assign(state, JSON.parse(localStorage.getItem("ffa-state") || "{}")); } catch { /* storage unavailable */ }
const save = () => { try { localStorage.setItem("ffa-state", JSON.stringify({ stage: state.stage, model: state.model, lookback: state.lookback, period: state.period })); } catch { /* ignore */ } };

const opts = (extra = {}) => ({ model: state.model, lookbackDays: +state.lookback, period: E.periods[state.period].range, ...extra });
const chLabel = (i) => E.channels[i].label;
const modelLabel = (id = state.model) => MODELS.find((m) => m.id === id).label;
const stageLabel = (id = state.stage) => STAGE[id].label;
const creditWord = (stage) => (STAGE[stage].revenue ? "revenue" : "conversions");

async function init() {
  const res = await fetch("data/acme.json");
  const raw = await res.json();
  E = createEngine(raw);
  const stageSel = $("#ctl-stage"), modelSel = $("#ctl-model"), periodSel = $("#ctl-period");
  stageSel.innerHTML = `<optgroup label="Presale">${STAGES.filter((s) => s.phase === "presale").map((s) => `<option value="${s.id}">${s.label}</option>`).join("")}</optgroup>
    <optgroup label="Postsale">${STAGES.filter((s) => s.phase === "postsale").map((s) => `<option value="${s.id}">${s.label}</option>`).join("")}</optgroup>`;
  modelSel.innerHTML = MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  periodSel.innerHTML = Object.values(E.periods).map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
  stageSel.value = state.stage; modelSel.value = state.model; $("#ctl-lookback").value = String(state.lookback); periodSel.value = state.period;
  $("#controls").addEventListener("change", () => {
    state.stage = stageSel.value; state.model = modelSel.value; state.lookback = +$("#ctl-lookback").value; state.period = periodSel.value;
    save(); render();
  });
  $("#controls").addEventListener("submit", (e) => e.preventDefault());
  addEventListener("hashchange", route);
  route();
  startTour(E);
}

function route() {
  const h = location.hash.slice(1);
  state.tab = TABS.includes(h) ? h : "overview";
  document.querySelectorAll("#tabs a").forEach((a) => (a.dataset.tab === state.tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  render();
}

function render() {
  const note = $("#model-note");
  const m = state.model, s = state.stage;
  const notes = [];
  if (m === "w_shaped" && (s === "mql" || s === "pql")) notes.push("W-shaped needs a lead-creation and an opportunity milestone, so for MQL and PQL it falls back to U-shaped.");
  if (m === "w_shaped" && STAGE[s].phase === "postsale") notes.push("For postsale conversions W-shaped falls back to U-shaped: the journey starts at the customer's original close.");
  if (m === "markov") notes.push("Markov credits channels by removal effect: how many conversions would be lost without the channel. Asset credit splits each channel's share by its linear asset mix.");
  if (STAGE[s].phase === "postsale") notes.push("Postsale attribution only counts touches after the customer's original close, so presale campaigns never get renewal, upsell or expansion credit.");
  note.hidden = !notes.length;
  note.textContent = notes.join(" ");
  const fn = { overview, channels, collateral, journeys, postsale, optimization, method }[state.tab];
  view.innerHTML = fn();
  bindTooltips(view);
  wire();
}

// ---------------------------------------------------------------------------
function kpiStrip() {
  const k = E.kpis(E.periods[state.period].range);
  const cell = (label, v, d, cls = "") => `<div class="kpi ${cls}"><span class="k">${label}</span><span class="v">${v}</span><span class="d">${d}</span></div>`;
  return `<section class="kpis" aria-label="Funnel totals">
    ${cell("MQLs", fmtN(k.mql), `${fmtN(k.contacts)} new contacts`)}
    ${cell("PQLs", fmtN(k.pql), `${fmtN(k.signups)} product signups`)}
    ${cell("SQLs", fmtN(k.sql), `${pct(k.sql / Math.max(1, k.mql + k.pql))} of MQL + PQL`)}
    ${cell("Opportunities", fmtN(k.opp), `${fmt$(k.pipeline)} pipeline`)}
    ${cell("New business won", fmt$(k.wonValue), `${fmtN(k.won)} deals · ${pct(k.winRate)} win rate`)}
    ${cell("Postsale won", fmt$(k.postsaleValue), `renewal ${fmt$(k.renewalValue)} · upsell ${fmt$(k.upsellValue)} · expansion ${fmt$(k.expansionValue)}`, "post")}
    ${cell("Marketing spend", fmt$(k.spend), `${((k.wonValue + k.postsaleValue) / k.spend).toFixed(1)}x revenue ÷ spend`)}
  </section>`;
}

function creditRows(r, stage, { limit = 13 } = {}) {
  const rev = STAGE[stage].revenue;
  return r.channels.map((c, i) => ({ i, credit: c.credit, value: c.value }))
    .filter((c) => c.credit > 0.001)
    .sort((a, b) => (rev ? b.value - a.value : b.credit - a.credit))
    .slice(0, limit)
    .map((c) => {
      const share = c.credit / Math.max(1e-9, r.conversions - r.unattributed);
      return {
        label: chLabel(c.i), value: rev ? c.value : c.credit,
        display: rev ? fmt$(c.value) : fmtN(c.credit, c.credit < 10 ? 1 : 0),
        tip: `<b>${esc(chLabel(c.i))}</b><br>${fmtN(c.credit, 1)} ${STAGE[stage].label} credits (${pct(share, 1)})${rev ? `<br>${fmt$(c.value)} attributed revenue` : ""}`,
      };
    });
}

function overview() {
  const r = E.attribute(opts({ stage: state.stage }));
  const sugg = E.suggestions(opts()).filter((s) => s.severity !== "info").slice(0, 3);
  // model comparison heatmap
  const cmp = MODELS.map((m) => E.attribute(opts({ stage: state.stage, model: m.id })));
  const tot = Math.max(1e-9, r.conversions - r.unattributed);
  const rows = E.channels.map((c, i) => ({ i, shares: cmp.map((x) => x.channels[i].credit / tot) })).filter((x) => x.shares.some((v) => v > 0.002))
    .sort((a, b) => b.shares[MODELS.findIndex((m) => m.id === state.model)] - a.shares[MODELS.findIndex((m) => m.id === state.model)]);
  const max = Math.max(...rows.flatMap((x) => x.shares));
  const spread = rows.map((x) => Math.max(...x.shares) - Math.min(...x.shares));
  const contested = rows[spread.indexOf(Math.max(...spread))];
  return `
  ${kpiStrip()}
  <div class="grid-2">
    <section class="panel">
      <div class="panel-head"><h2>Who gets credit for ${stageLabel()}</h2><p>${fmtN(r.conversions)} ${stageLabel()}${STAGE[state.stage].revenue ? ` deals worth ${fmt$(r.totalValue)}` : "s"} · ${modelLabel()}${r.unattributed ? ` · ${r.unattributed} with no touches in the lookback` : ""}</p></div>
      ${hbar(creditRows(r, state.stage))}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Where the models disagree</h2><p>Share of ${stageLabel()} credit by model. The widest rows are where budget arguments start${contested ? `; here, ${esc(chLabel(contested.i))} swings from ${pct(Math.min(...contested.shares))} to ${pct(Math.max(...contested.shares))}` : ""}.</p></div>
      <div class="tbl-wrap"><table class="heat"><thead><tr><th>Channel</th>${MODELS.map((m) => `<th class="c" title="${m.label}">${m.short}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((x) => `<tr><td>${esc(chLabel(x.i))}</td>${x.shares.map((v, j) => `<td class="cell" style="${heatStyle(v, max)}" data-tip="<b>${esc(chLabel(x.i))}</b><br>${MODELS[j].label}: ${pct(v, 1)} of credit">${v >= 0.0005 ? pct(v) : "–"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    </section>
  </div>
  <section class="panel">
    <div class="panel-head"><h2>Top actions</h2><p>From the Optimization tab, based on ${modelLabel()} credit and collateral lift.</p><a href="#optimization">All recommendations and the leadership deck →</a></div>
    <div class="recs">${sugg.map(recCard).join("")}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
function channels() {
  const eff = E.efficiency(opts());
  const cols = [
    ["label", "Channel", false], ["cost", "Spend", true], ["mql", "MQL", true], ["pql", "PQL", true], ["sql", "SQL", true], ["opp", "Opps", true],
    ["wonValue", "Won revenue", true], ["post", "Postsale revenue", true], ["costPerSql", "Cost / SQL", true], ["roi", "Revenue ÷ spend", true],
  ];
  const rows = eff.map((r) => ({ ...r, post: r.renewalValue + r.upsellValue + r.expansionValue }));
  const k = state.chSort;
  rows.sort((a, b) => {
    const va = a[k] ?? -Infinity, vb = b[k] ?? -Infinity;
    if (typeof va === "string") return state.chAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return state.chAsc ? va - vb : vb - va;
  });
  const cell = (r, key) => {
    const v = r[key];
    if (key === "label") return `<td>${esc(v)}<span class="sub">${esc(r.group)}</span></td>`;
    if (["cost", "wonValue", "post", "costPerSql"].includes(key)) return `<td class="n">${fmt$(v)}</td>`;
    if (key === "roi") return `<td class="n">${v == null ? "–" : v.toFixed(1) + "x"}</td>`;
    return `<td class="n">${fmtN(v, v < 10 ? 1 : 0)}</td>`;
  };
  // stage mix heatmap
  const stageShares = STAGES.map((s) => {
    const a = E.attribute(opts({ stage: s.id }));
    const t = Math.max(1e-9, a.conversions - a.unattributed);
    return a.channels.map((c) => c.credit / t);
  });
  const camp = E.attribute(opts({ stage: state.stage }));
  const rev = STAGE[state.stage].revenue;
  const topCamps = E.campaigns.map((c, i) => ({ c, ...camp.campaigns[i] })).filter((x) => x.credit > 0.01)
    .sort((a, b) => (rev ? b.value - a.value : b.credit - a.credit)).slice(0, 12);
  return `
  <section class="panel">
    <div class="panel-head"><h2>Channel performance</h2><p>Credited conversions per stage under ${modelLabel()}, ${+state.lookback ? state.lookback + "-day" : "full-history"} lookback. Spend comes from campaign costs and monthly program budgets. Click a column to sort.</p></div>
    <div class="tbl-wrap"><table id="ch-table"><thead><tr>${cols.map(([key, label, n]) => `<th class="${n ? "n" : ""} ${state.chSort === key ? "sorted" + (state.chAsc ? " asc" : "") : ""}" data-sort="${key}">${label}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map(([key]) => cell(r, key)).join("")}</tr>`).join("")}</tbody></table></div>
  </section>
  <div class="grid-2">
    <section class="panel">
      <div class="panel-head"><h2>Where each channel earns its credit</h2><p>Share of each stage's credit, ${modelLabel()}. Feeder channels light up on the left; closers on the right.</p></div>
      <div class="tbl-wrap"><table class="heat"><thead><tr><th>Channel</th>${STAGES.map((s) => `<th class="c">${s.label}</th>`).join("")}</tr></thead>
      <tbody>${E.channels.map((c, i) => `<tr><td>${esc(c.label)}</td>${STAGES.map((s, j) => {
        const v = stageShares[j][i];
        return `<td class="cell" style="${heatStyle(v, 0.35)}" data-tip="<b>${esc(c.label)}</b><br>${pct(v, 1)} of ${s.label} credit">${v >= 0.005 ? pct(v) : "–"}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Top campaigns for ${stageLabel()}</h2><p>${modelLabel()}. Event dates and costs come from the campaign record.</p></div>
      <div class="tbl-wrap"><table><thead><tr><th>Campaign</th><th class="n">Cost</th><th class="n">${rev ? "Revenue" : "Credit"}</th></tr></thead>
      <tbody>${topCamps.map((x) => `<tr><td>${esc(x.c.name)}<span class="sub">${esc(E.channels.find((c) => c.id === x.c.channel).label)}${x.c.type === "event" || x.c.type === "webinar" ? " · " + E.dateOf(x.c.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""}</span></td><td class="n">${x.c.cost ? fmt$(x.c.cost) : "program"}</td><td class="n">${rev ? fmt$(x.value) : fmtN(x.credit, 1)}</td></tr>`).join("")}</tbody></table></div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
function liftCellsHead() {
  return `<div class="lift-head">${STAGES.map((s) => `<span title="${s.label}">${s.label.replace("Opportunity", "Opp").replace("Closed-won", "Won").replace("Expansion", "Exp").replace("Renewal", "Ren").replace("Upsell", "Ups")}</span>`).join("")}</div>`;
}
function liftCells(a) {
  return `<div class="lift-cells">${a.rows.map((r) => {
    const s = STAGE[r.stage];
    let cls = "na", txt = "", tipTxt = `<b>${s.label}</b><br>Not enough exposure to measure (${r.touches} ${r.method === "touch" ? "touches" : "deals"}).`;
    if (r.enough) {
      txt = r.lift.toFixed(1);
      cls = r.sig ? (r.lift > 1 ? "pos" : "neg") : "flat";
      tipTxt = `<b>${s.label}: ${r.lift.toFixed(2)}x</b><br>${r.sig ? "Statistically significant (FDR 10%)" : "Not significant: treat as no effect"}<br>${fmtN(r.touches)} ${r.method === "touch" ? "touches" : "exposed deals"} · z = ${r.z.toFixed(1)}`;
    }
    return `<span class="lift-cell ${cls}" tabindex="0" data-tip="${esc(tipTxt)}">${txt}</span>`;
  }).join("")}</div>`;
}
function collateral() {
  const sc = E.scorecard();
  const r = E.attribute(opts({ stage: state.stage }));
  const rev = STAGE[state.stage].revenue;
  const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, sc.filter((a) => a.status === k).length]));
  let rows = sc.map((a, i) => ({ ...a, credit: r.assets[i].credit, value: r.assets[i].value }));
  if (state.statusFilter !== "all") rows = rows.filter((a) => a.status === state.statusFilter);
  const k = state.asSort;
  const key = (a) => (k === "status" ? STATUS[a.status].order * 1e6 - (a.best?.lift || 0) * 1e3 : k === "credit" ? (rev ? a.value : a.credit) : k === "reach" ? a.contacts : k === "name" ? a.name : a.production_cost);
  rows.sort((a, b) => {
    const va = key(a), vb = key(b);
    const d = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return state.asAsc ? d : -d;
  });
  const th = (k2, label, n) => `<th class="${n ? "n" : ""} ${state.asSort === k2 ? "sorted" + (state.asAsc ? " asc" : "") : ""}" data-asort="${k2}" data-sort>${label}</th>`;
  return `
  <section class="panel">
    <div class="panel-head"><h2>Collateral scorecard</h2><p>Credit tells you where an asset showed up. Lift tells you whether it changed anything: how much more often a touch with this asset is followed by the next stage than a comparable touch in the same channel, at the same depth of engagement. Green and red cells are significant after false-discovery correction; grey means no detectable effect; dashed means too little exposure to judge.</p></div>
    <div class="chips" role="group" aria-label="Filter by verdict">
      <button class="chip" data-filter="all" aria-pressed="${state.statusFilter === "all"}">All ${sc.length}</button>
      ${Object.entries(STATUS).map(([k2, v]) => `<button class="chip" data-filter="${k2}" aria-pressed="${state.statusFilter === k2}">${v.label} ${counts[k2]}</button>`).join("")}
    </div>
    <div class="tbl-wrap" style="margin-top:12px"><table id="as-table"><thead><tr>
      ${th("name", "Asset")}${th("status", "Verdict")}${th("reach", "Reach", true)}${th("credit", `${stageLabel()} ${rev ? "revenue" : "credit"}`, true)}
      <th>Lift by stage${liftCellsHead()}</th>${th("cost", "Cost", true)}</tr></thead>
    <tbody>${rows.map((a) => `<tr>
      <td>${esc(a.name)}<span class="sub">${esc(a.type)} · built for ${STAGE[a.intended_stage].label}${a.mismatch ? ` · <b>works at ${STAGE[a.mismatch].label}</b>` : ""}</span></td>
      <td><span class="pill ${a.status}">${STATUS[a.status].label}</span></td>
      <td class="n">${fmtN(a.contacts)}<span class="sub">${fmtN(a.accounts)} accounts</span></td>
      <td class="n">${rev ? fmt$(a.value) : fmtN(a.credit, 1)}</td>
      <td>${liftCells(a)}</td>
      <td class="n">${fmt$(a.production_cost)}</td></tr>`).join("")}</tbody></table></div>
  </section>`;
}

// ---------------------------------------------------------------------------
function journeys() {
  const p = E.paths(state.stage, opts());
  const mk = E.markovEffects(state.stage, { lookbackDays: +state.lookback, useEventDate: false });
  const h = E.hygiene(opts());
  const rows = E.channels.map((c, i) => ({ label: c.label, value: mk.removal[i], display: pct(mk.removal[i], 1), tip: `<b>${esc(c.label)}</b><br>Removing it would cut ${STAGE[state.stage].label} conversion probability by ${pct(mk.removal[i], 1)}<br>Share of Markov credit: ${pct(mk.share[i], 1)}` }))
    .filter((r) => r.value > 0.0005).sort((a, b) => b.value - a.value);
  const step = (i) => (i === -1 ? `<span class="step gap">···</span>` : `<span class="step">${esc(chLabel(i))}</span>`);
  return `
  <section class="panel">
    <div class="panel-head"><h2>Journeys to ${stageLabel()}</h2><p>Channel sequences in the ${+state.lookback ? state.lookback + "-day" : "full"} lookback before each conversion, with repeats collapsed.</p></div>
    <div class="split">
      <div class="stat"><span class="v">${fmtN(p.avgTouches, 1)}</span><span class="k">touches per conversion</span></div>
      <div class="stat"><span class="v">${fmtN(p.avgDays, 0)} days</span><span class="k">from first touch in window to ${stageLabel()}</span></div>
      <div class="stat"><span class="v">${fmtN(p.distinctPaths)}</span><span class="k">distinct paths across ${fmtN(p.conversions)} conversions</span></div>
      <div class="stat"><span class="v">${pct(p.top.slice(0, 5).reduce((a, t) => a + t.share, 0))}</span><span class="k">start and end with one of the five pairs below</span></div>
    </div>
  </section>
  <div class="grid-2">
    <section class="panel">
      <div class="panel-head"><h2>How journeys open and close</h2><p>Opening channel → closing channel. The dots stand for the touches in between.</p></div>
      ${p.top.map((t) => `<div class="path">${t.steps.map(step).join('<span class="arr">→</span>')}<span class="ct">${fmtN(t.count)} · ${pct(t.share, 1)}</span></div>`).join("")}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>What each channel is worth to ${stageLabel()}</h2><p>Markov removal effect: the drop in conversion probability if the channel vanished from every journey, using ${fmtN(mk.units)} journeys (${fmtN(mk.converted)} converted).</p></div>
      ${hbar(rows)}
    </section>
  </div>
  ${hygienePanel(h)}`;
}
function hygienePanel(h) {
  return `<section class="callout">
    <div class="panel-head" style="margin:0"><h2>Data quality: offline touches</h2><p>Event scans, syndication leads and partner referrals are dated by HubSpot record creation, so a list uploaded late lands after the conversions it influenced.</p></div>
    <div class="split">
      <div class="stat"><span class="v">${pct(h.lateShare)}</span><span class="k">of ${fmtN(h.eventTouches)} event touches logged more than 3 days after the event</span></div>
      <div class="stat"><span class="v">${fmtN(h.avgLagDays, 0)} days</span><span class="k">average delay on late uploads</span></div>
      <div class="stat"><span class="v">${fmtN(h.crossed)}</span><span class="k">late touches landed after a stage change they likely influenced</span></div>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>Stage</th><th class="n">Event credit, record date (current)</th><th class="n">If dated by event date</th><th class="n">Difference</th></tr></thead>
    <tbody>${h.impact.map((x) => `<tr><td>${STAGE[x.stage].label}</td><td class="n">${x.stage === "won" ? fmt$(x.valueLogged) : fmtN(x.creditLogged, 1)}</td><td class="n">${x.stage === "won" ? fmt$(x.valueEventDate) : fmtN(x.creditEventDate, 1)}</td><td class="n">${x.stage === "won" ? fmt$(x.valueEventDate - x.valueLogged) : (x.creditEventDate - x.creditLogged >= 0 ? "+" : "") + fmtN(x.creditEventDate - x.creditLogged, 1)}</td></tr>`).join("")}</tbody></table></div>
    <p class="small muted">Fix at the source: a 72-hour upload rule for event lists keeps record dates close to event dates.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
function postsale() {
  const k = E.kpis(E.periods[state.period].range);
  const ps = E.postsale(E.periods[state.period].range);
  const sc = E.scorecard();
  const cols = ["renewal", "upsell", "expansion"].map((s) => {
    const r = E.attribute(opts({ stage: s }));
    return `<section class="panel"><div class="panel-head"><h3>${STAGE[s].label}: ${fmt$(r.totalValue)}</h3><p>${fmtN(r.conversions)} deals · ${modelLabel(state.model === "w_shaped" ? "u_shaped" : state.model)}</p></div>${hbar(creditRows(r, s, { limit: 7 }))}</section>`;
  }).join("");
  const postAssets = sc.filter((a) => STAGE[a.intended_stage].phase === "postsale" || a.rows.some((r) => STAGE[r.stage].phase === "postsale" && r.sig && r.lift > 1));
  return `
  <section class="kpis">
    <div class="kpi post"><span class="k">Renewals won</span><span class="v">${fmt$(k.renewalValue)}</span><span class="d">${fmtN(k.renewal)} renewals · ${pct(k.renewalRate)} renewal rate</span></div>
    <div class="kpi post"><span class="k">Upsell</span><span class="v">${fmt$(k.upsellValue)}</span><span class="d">${fmtN(k.upsell)} deals</span></div>
    <div class="kpi post"><span class="k">Expansion</span><span class="v">${fmt$(k.expansionValue)}</span><span class="d">${fmtN(k.expansion)} deals</span></div>
    <div class="kpi"><span class="k">Gross retention</span><span class="v">${pct(ps.grossRetention)}</span><span class="d">of ACV up for renewal</span></div>
    <div class="kpi"><span class="k">Renewal rate, adopted vs not</span><span class="v">${pct(ps.adoptedRate)} / ${pct(ps.notAdoptedRate)}</span><span class="d">${fmtN(ps.adoptedN)} accounts with an activated user vs ${fmtN(ps.notAdoptedN)} without</span></div>
  </section>
  <p class="lede">Postsale attribution starts the clock at the customer's original close. Only customer-phase touches compete for renewal, upsell and expansion credit, so in-product promotion, customer email and user events are measured on the revenue they keep and grow.</p>
  <div class="grid-3">${cols}</div>
  <section class="panel">
    <div class="panel-head"><h2>Customer collateral</h2><p>Renewal is judged deal by deal: renewals that saw the asset vs comparable renewals that didn't. Upsell and expansion are judged by how much customers engaged with the asset.</p></div>
    <div class="tbl-wrap"><table><thead><tr><th>Asset</th><th>Verdict</th><th class="n">Accounts reached</th><th class="n">Renewal</th><th class="n">Upsell</th><th class="n">Expansion</th></tr></thead>
    <tbody>${postAssets.map((a) => `<tr><td>${esc(a.name)}<span class="sub">${esc(a.type)} · built for ${STAGE[a.intended_stage].label}</span></td><td><span class="pill ${a.status}">${STATUS[a.status].label}</span></td><td class="n">${fmtN(a.accounts)}</td>${["renewal", "upsell", "expansion"].map((s) => {
      const r = a.rows.find((x) => x.stage === s);
      return `<td class="n">${r.enough ? `<span class="${r.sig ? (r.lift > 1 ? "pill double_down" : "pill kill") : "muted"}" style="${r.sig ? "" : ""}">${r.lift.toFixed(2)}x</span>` : '<span class="muted">n/a</span>'}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>
  </section>`;
}

// ---------------------------------------------------------------------------
function recCard(s) {
  const sevLabel = { critical: "Kill", warning: "Fix", opportunity: "Opportunity", good: "Double down", info: "Read carefully" }[s.severity];
  return `<article class="rec ${s.severity}"><span class="stripe"></span><div class="body"><h3>${esc(s.title)}</h3><p>${esc(s.detail)}</p></div><div class="meta"><span class="sev">${sevLabel}</span><span class="metric">${esc(s.metric || "")}</span></div></article>`;
}
function optimization() {
  const sc = E.scorecard();
  const sugg = E.suggestions(opts());
  const med = sc[0].medianReach;
  const items = sc.map((a) => {
    // plot the significant effect; assets with no detectable effect sit on the 1x line
    const top = a.best || a.worst;
    const jitter = top ? 1 : Math.exp(((a.id.charCodeAt(2) % 5) - 2) * 0.012);
    return {
      reach: a.contacts, lift: top ? top.lift : jitter, status: a.status,
      label: ["double_down", "amplify"].includes(a.status) || (a.status === "kill" && a.worst) ? shortName(a.name) : "",
      tip: `<b>${esc(a.name)}</b><br>${STATUS[a.status].label}<br>${fmtN(a.contacts)} contacts reached<br>${top ? `${top.lift.toFixed(2)}x at ${STAGE[top.stage].label}` : "No significant effect at any stage"}<br>Production cost ${fmt$(a.production_cost)}`,
    };
  });
  const list = (status, what) => {
    const xs = sc.filter((a) => a.status === status).sort((a, b) => (b.best?.lift || 0) - (a.best?.lift || 0) || b.contacts - a.contacts);
    return `<div class="verdict"><h3>${STATUS[status].label} <span class="pill ${status}">${xs.length}</span></h3><p class="what">${what}</p><ul>${xs.map((a) => `<li>${esc(a.name)}<span class="m">${a.best ? `${a.best.lift.toFixed(1)}x at ${STAGE[a.best.stage].label} · ` : a.worst ? `${a.worst.lift.toFixed(2)}x at ${STAGE[a.worst.stage].label} · ` : ""}${fmtN(a.contacts)} contacts</span></li>`).join("") || '<li class="muted">None</li>'}</ul></div>`;
  };
  const insuff = sc.filter((a) => a.status === "insufficient");
  return `
  <section class="panel opt-bar">
    <div><h2>Optimization</h2><p class="lede">Verdicts come from collateral lift, which doesn't depend on the model; channel and cost recommendations use ${modelLabel()} credit for ${E.periods[state.period].label}.</p></div>
    <div class="btn-row">
      <button class="btn primary" id="btn-deck" type="button">Build leadership deck (.pptx)</button>
      <button class="btn" id="btn-csv" type="button">Export scorecard (.csv)</button>
    </div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Kill or double down</h2><p>Each dot is an asset, placed at its significant lift (assets with no detectable effect sit on the 1x line). Right means more contacts engaged with it. Dashed lines mark median reach and 1.2x lift.</p></div>
    <div class="quad-wrap">${quadrant(items, { medianReach: med })}</div>
    <div class="legend">${Object.entries(STATUS).map(([k2, v]) => `<span class="pill ${k2}">${v.label}</span>`).join("")}</div>
  </section>
  <div class="verdicts">
    ${list("double_down", "Proven lift and wide reach. Protect the budget, refresh editions, spin off formats.")}
    ${list("amplify", "Proven lift, under-distributed. The cheapest growth here: put them in more sequences.")}
    ${list("fix", "Wide reach, no measurable effect. Rework the offer, or give the slots to a proven asset.")}
    ${list("kill", "No lift and little reach, or lift below 1. Pull them from sequences.")}
  </div>
  ${insuff.length ? `<p class="small muted">Not enough data yet: ${insuff.map((a) => esc(a.name) + ` (${a.contacts} contacts)`).join(", ")}. Keep it in market until it has at least 25 measurable touches.</p>` : ""}
  <section class="panel">
    <div class="panel-head"><h2>Recommendations</h2><p>${sugg.length} findings, most urgent first. Rules run on the scorecard, channel cost per stage, first- vs last-touch disagreement, PLG activation and data quality.</p></div>
    <div class="recs">${sugg.map(recCard).join("")}</div>
  </section>
  ${hygienePanel(E.hygiene(opts()))}`;
}
const shortName = (n) => n.replace(/^(Customer story|Webinar|In-app guide|In-app promo|Blog|Infographic|Analyst Brief): /, "").replace(/ \(.*\)$/, "").slice(0, 30);

// ---------------------------------------------------------------------------
function method() {
  return `<section class="panel method">
    <h2>How this works</h2>
    <p>Full-Funnel Attribution reads one normalized dataset: accounts, contacts with lifecycle timestamps, deals, campaigns, assets, costs and touches. The demo's dataset comes from a seeded generator that simulates 24 months of Acme Corp's hybrid sales-led and product-led motion. The HubSpot connector produces the same shape from a live portal, so every view here works on real data unchanged.</p>
    <h3>Conversions</h3>
    <ul>
      <li><b>MQL and PQL</b> are the two front doors. PQLs come from the product path: signup, activation, then a product-qualified signal.</li>
      <li><b>SQL</b> and <b>Opportunity</b> follow. Opportunity and Closed-won are account-level: touches from every contact at the account count.</li>
      <li><b>Postsale attribution</b> covers renewal, upsell and expansion. The window opens at the customer's original close, so only customer-phase touches compete for that revenue.</li>
    </ul>
    <h3>Attribution models</h3>
    <ul>
      <li><b>First touch, last touch, linear</b>: the standard references.</li>
      <li><b>Time decay</b>: credit halves for every 7 days between touch and conversion.</li>
      <li><b>U-shaped</b>: 40% first, 40% last, 20% spread across the middle.</li>
      <li><b>W-shaped</b>: 30% each to first touch, lead creation (the last touch before the first MQL or PQL) and opportunity creation, with 10% across the rest. Falls back to U-shaped where a milestone doesn't exist.</li>
      <li><b>Markov</b>: a first-order chain over channel sequences, including journeys that never converted. A channel's credit is its removal effect.</li>
    </ul>
    <h3>Collateral lift: why credit isn't enough</h3>
    <p>An asset that appears in every journey collects credit under every model, whether or not it does anything. Lift asks a different question: holding the channel and the buyer's engagement constant, is a touch with this asset followed by the next stage more often? Each stage gets a regularized logistic regression. For MQL, PQL, SQL and Opportunity the unit is a touch and the outcome is reaching the stage within 7–14 days. For Closed-won, renewal, upsell and expansion the unit is the deal or customer, with controls for touch volume and the channels involved. Results are corrected for running many tests at once (Benjamini-Hochberg, 10% false discovery rate). An asset is judged on the phase it was built for: presale or postsale.</p>
    <h3>Verdicts</h3>
    <ul>
      <li><b>Double down</b>: significant lift of at least 1.2x, and reach at or above the median asset.</li>
      <li><b>Amplify</b>: the same lift with below-median reach.</li>
      <li><b>Fix or replace</b>: no significant effect despite above-median reach.</li>
      <li><b>Kill</b>: significant negative effect, or no effect and little reach.</li>
      <li><b>Not enough data</b>: fewer than 25 measurable touches (12 deals) at every stage.</li>
    </ul>
    <h3>Offline and third-party touches</h3>
    <p>Events, syndication and partner referrals take the HubSpot record creation timestamp. The Journeys and Optimization tabs show what that costs when lists are uploaded late, as a what-if against the campaign's event date.</p>
    <h3>Validation</h3>
    <p>The generator plants known effects (for example, the ROI calculator triples the odds of winning; the buyer's guide does nothing). <code>tests/engine.test.mjs</code> checks that every model conserves credit and that significant lifts point the same way as the planted effects.</p>
    <h3>HubSpot mapping</h3>
    <ul>
      <li>Contacts and lifecycle stage dates come from <code>hs_lifecyclestage_*_date</code> properties. PQL and activation come from product properties or custom events.</li>
      <li>Deals with <code>dealtype</code> new business, renewal, upsell and expansion are associated to companies.</li>
      <li>Touches are form submissions, marketing email clicks, page views, ad interactions, campaign membership, sales activities and custom behavioral events. Assets map from file, page or campaign asset IDs to an asset registry.</li>
      <li>Costs come from campaign budget fields plus a monthly program-spend CSV.</li>
    </ul>
  </section>`;
}

// ---------------------------------------------------------------------------
function wire() {
  view.querySelectorAll("#ch-table th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    state.chAsc = state.chSort === k ? !state.chAsc : k === "label";
    state.chSort = k;
    render();
  }));
  view.querySelectorAll("#as-table th[data-asort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.asort;
    state.asAsc = state.asSort === k ? !state.asAsc : k === "name" || k === "status";
    state.asSort = k;
    render();
  }));
  view.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { state.statusFilter = b.dataset.filter; render(); }));
  const deckBtn = $("#btn-deck");
  if (deckBtn) deckBtn.addEventListener("click", async () => {
    deckBtn.disabled = true;
    deckBtn.textContent = "Building deck…";
    try {
      const blob = await buildDeck(E, { ...state, opts: opts(), fmt$, fmtN, pct });
      await saveFile(`Acme-attribution-readout-${E.periods[state.period].id}.pptx`, blob);
    } catch (e) {
      toast("Couldn't build the deck: " + (e.message || e.code || e));
    } finally {
      deckBtn.disabled = false;
      deckBtn.textContent = "Build leadership deck (.pptx)";
    }
  });
  const csvBtn = $("#btn-csv");
  if (csvBtn) csvBtn.addEventListener("click", () => {
    const sc = E.scorecard();
    const head = ["asset_id", "asset", "type", "built_for", "verdict", "contacts_reached", "accounts_reached", "production_cost", ...STAGES.flatMap((s) => [`${s.id}_lift`, `${s.id}_significant`])];
    const lines = [head.join(",")].concat(sc.map((a) => [a.id, `"${a.name.replace(/"/g, '""')}"`, a.type, a.intended_stage, STATUS[a.status].label, a.contacts, a.accounts, a.production_cost,
      ...a.rows.flatMap((r) => [r.enough ? r.lift.toFixed(3) : "", r.enough ? (r.sig ? "yes" : "no") : "insufficient"])].join(",")));
    saveFile("Acme-collateral-scorecard.csv", new Blob([lines.join("\n")], { type: "text/csv" }));
  });
}

async function saveFile(filename, blob) {
  // In claude.ai the page runs sandboxed: use the platform's downloads capability. Elsewhere (GitHub Pages) a normal download.
  let dl = null;
  if (window.claude?.use) {
    try { dl = await Promise.race([window.claude.use("downloads"), new Promise((r) => setTimeout(() => r(null), 1500))]); } catch { dl = null; }
  }
  if (dl) {
    try {
      await dl.save({ filename, data: blob });
      toast(`Saved ${filename}`);
    } catch (e) {
      if (e?.code !== "declined") toast("Download unavailable here: " + (e?.message || e?.code));
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Downloaded ${filename}`);
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3500);
}

init().catch((e) => {
  view.innerHTML = `<div class="callout"><h2>Couldn't load the demo data</h2><p>${esc(e.message)}. If you opened index.html straight from disk, serve the folder instead: <code>python3 -m http.server -d docs</code>.</p></div>`;
});
