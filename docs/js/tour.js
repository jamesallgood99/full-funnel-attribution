// Product tour for the public demo: an intro screen and the four views worth seeing.
// It opens on a first visit (or with ?tour in the URL), and the ribbon's "Take the tour" button reopens it.
// As you step through, the dashboard behind it switches to that view. Every number comes from the engine,
// run with the demo defaults (W-shaped, SQL, 365-day lookback, all periods), not from the visitor's settings.
import { MODELS, STATUS } from "./engine.js";
import { esc } from "./charts.js";

const SEEN = "ffa-tour-seen";
const seen = () => { try { return localStorage.getItem(SEEN) === "1"; } catch { return false; } };
const markSeen = () => { try { localStorage.setItem(SEEN, "1"); } catch { /* private mode: fine */ } };

const fmtN = (v) => Math.round(v).toLocaleString("en-US");
const fmt$ = (v) => (Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : "$" + Math.round(v / 1e3) + "K");
const pct = (v) => Math.round(v * 100) + "%";
const short = (n) => n.replace(/^(Customer story|Webinar|In-app guide|In-app promo|Blog|Infographic|Analyst Brief): /, "");
const STAGE_LABEL = { mql: "MQL", pql: "PQL", sql: "SQL", opp: "opportunity", won: "closed-won", renewal: "renewal", upsell: "upsell", expansion: "expansion" };

function facts(E) {
  const range = E.periods.all.range;
  const o = (x = {}) => ({ model: "w_shaped", lookbackDays: 365, period: range, ...x });
  const k = E.kpis(range);

  // Where the models disagree about SQL credit.
  const cmp = MODELS.map((m) => E.attribute(o({ stage: "sql", model: m.id })));
  const rows = E.channels.map((c, i) => {
    const shares = cmp.map((x) => x.channels[i].credit / Math.max(1e-9, x.conversions - x.unattributed));
    return { label: c.label, shares, spread: Math.max(...shares) - Math.min(...shares) };
  }).sort((a, b) => b.spread - a.spread).slice(0, 3);
  const top = rows[0];
  const lo = top.shares.indexOf(Math.min(...top.shares)), hi = top.shares.indexOf(Math.max(...top.shares));

  // Collateral: a wide-reach asset that does nothing, and the strongest winners.
  const sc = E.scorecard();
  const counts = Object.fromEntries(Object.keys(STATUS).map((s) => [s, sc.filter((a) => a.status === s).length]));
  const dud = sc.filter((a) => a.status === "fix").sort((a, b) => b.contacts - a.contacts)[0];
  const PRE = ["mql", "pql", "sql", "opp", "won"];
  const winners = sc.filter((a) => a.best && PRE.includes(a.best.stage) && ["double_down", "amplify"].includes(a.status)).sort((a, b) => b.best.lift - a.best.lift).slice(0, 2);

  // Postsale.
  const ps = E.postsale(range);
  const post = ["renewal", "upsell", "expansion"].map((s) => {
    const r = E.attribute(o({ stage: s, model: "u_shaped" }));
    return { stage: s, total: r.totalValue, deals: r.conversions };
  });
  const postWinner = sc.filter((a) => a.best && ["upsell", "expansion", "renewal"].includes(a.best.stage)).sort((a, b) => b.best.lift - a.best.lift)[0];

  // Optimization.
  const sugg = E.suggestions(o()).filter((s) => s.severity !== "info").slice(0, 3);

  return {
    k, ps, post, postWinner, sugg, counts, dud, winners, total: sc.length,
    channels: E.channels.length, touches: E.touchCount, assets: E.assets.length,
    models: MODELS, contested: rows, top, lo: MODELS[lo], hi: MODELS[hi],
  };
}

// ---------- visuals ----------
function introVisual(f) {
  const k = f.k;
  const box = (label, v, sub, cls = "") => `<div class="tf-stage ${cls}"><span>${label}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  return `<div class="tf-intro">
    <div class="tf-funnel">
      <div class="tf-doors">${box("MQL", fmtN(k.mql), "marketing")}${box("PQL", fmtN(k.pql), "product")}</div>
      <span class="tf-arr" aria-hidden="true">→</span>${box("SQL", fmtN(k.sql))}
      <span class="tf-arr" aria-hidden="true">→</span>${box("Opportunity", fmtN(k.opp))}
      <span class="tf-arr" aria-hidden="true">→</span>${box("Closed-won", fmt$(k.wonValue), `${fmtN(k.won)} deals`)}
      <span class="tf-arr" aria-hidden="true">→</span>${box("Postsale", fmt$(k.postsaleValue), "renewal, upsell, expansion", "post")}
    </div>
    <div class="tf-scale"><span><b>${f.models.length}</b> models</span><span><b>8</b> stages</span><span><b>${f.channels}</b> channels</span><span><b>${f.assets}</b> assets</span><span><b>${fmtN(f.touches)}</b> touches</span></div>
  </div>`;
}

function modelsVisual(f) {
  const max = Math.max(...f.contested.flatMap((r) => r.shares));
  const cell = (v) => {
    const t = v / max;
    return `<td style="background:color-mix(in srgb, var(--accent) ${Math.round(t * 85)}%, var(--surface));color:${t > 0.55 ? "#fff" : "var(--ink)"}">${pct(v)}</td>`;
  };
  return `<div class="tf-scroll"><table class="tf-heat"><thead><tr><th>SQL credit</th>${f.models.map((m) => `<th>${esc(m.short)}</th>`).join("")}</tr></thead>
    <tbody>${f.contested.map((r) => `<tr><th scope="row">${esc(r.label)}</th>${r.shares.map(cell).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function collateralVisual(f) {
  const d = f.dud;
  return `<div class="tf-two">
    <div class="tf-assets">
      ${f.winners.map((a) => `<div class="tf-asset"><div><b>${esc(short(a.name))}</b><small>${fmtN(a.contacts)} contacts reached</small></div><div class="tf-asset-r"><span class="pill ${a.status}">${STATUS[a.status].label}</span><small>${a.best.lift.toFixed(2)}x at ${STAGE_LABEL[a.best.stage]}</small></div></div>`).join("")}
      ${d ? `<div class="tf-asset"><div><b>${esc(short(d.name))}</b><small>${fmtN(d.contacts)} contacts reached</small></div><div class="tf-asset-r"><span class="pill fix">${STATUS.fix.label}</span><small>No measurable lift</small></div></div>` : ""}
    </div>
    <div class="tf-counts"><span class="tf-label">${f.total} assets, by verdict</span>
      ${Object.entries(STATUS).map(([id, s]) => `<div><span class="pill ${id}">${s.label}</span><b>${f.counts[id]}</b></div>`).join("")}
    </div></div>`;
}

function postsaleVisual(f) {
  return `<div class="tf-two">
    <div class="tf-post">
      ${f.post.map((p) => `<div class="tf-post-row"><span>${STAGE_LABEL[p.stage][0].toUpperCase() + STAGE_LABEL[p.stage].slice(1)}</span><b>${fmt$(p.total)}</b><small>${fmtN(p.deals)} deals</small></div>`).join("")}
      <div class="tf-note">Only touches after the customer's original close count.</div>
    </div>
    <div class="tf-renew">
      <span class="tf-label">Renewal rate</span>
      <div class="tf-bar"><span>Adopted the product</span><i style="width:${pct(f.ps.adoptedRate)}"></i><b>${pct(f.ps.adoptedRate)}</b></div>
      <div class="tf-bar muted"><span>Never activated</span><i style="width:${pct(f.ps.notAdoptedRate)}"></i><b>${pct(f.ps.notAdoptedRate)}</b></div>
      ${f.postWinner ? `<div class="tf-asset" style="margin-top:10px"><div><b>${esc(short(f.postWinner.name))}</b><small>Customer collateral</small></div><div class="tf-asset-r"><span class="pill ${f.postWinner.status}">${STATUS[f.postWinner.status].label}</span><small>${f.postWinner.best.lift.toFixed(2)}x at ${STAGE_LABEL[f.postWinner.best.stage]}</small></div></div>` : ""}
    </div></div>`;
}

function optimizationVisual(f) {
  const sev = { critical: "Kill", warning: "Fix", opportunity: "Opportunity", good: "Double down" };
  return `<div class="tf-two tf-opt">
    <div class="tf-recs">${f.sugg.map((s) => `<div class="tf-rec ${s.severity}"><div><b>${esc(s.title)}</b><small>${esc(s.metric || "")}</small></div><span>${sev[s.severity] ?? ""}</span></div>`).join("")}</div>
    <div class="tf-deck" aria-hidden="true">
      <div class="tf-slide"><i></i><i></i><i></i></div><div class="tf-slide"><i></i><i></i></div><div class="tf-slide"><i></i><i></i><i></i></div>
      <span>Leadership deck<br><b>.pptx, editable</b></span>
    </div></div>`;
}

export function startTour(E) {
  let f = null;
  const steps = [
    { intro: true, kicker: "Product tour", tab: "overview", title: "Attribution from first touch through renewal",
      body: () => "Most attribution stops at the closed deal and argues about one model. This one runs seven models side by side across the whole funnel, including product-led signups and the revenue customers bring after they buy. It's built to plug into HubSpot. Acme Corp and all of its data are fictional.",
      visual: introVisual },
    { kicker: "Feature 1 of 4", tab: "overview", title: "See where the models disagree",
      body: (x) => `Every model tells a different story about the same buyers. ${esc(x.top.label)} gets ${pct(Math.min(...x.top.shares))} of SQL credit under ${esc(x.lo.label.toLowerCase())} and ${pct(Math.max(...x.top.shares))} under ${esc(x.hi.label.toLowerCase())}. The overview puts all seven next to each other, so the budget conversation starts from where they split.`,
      visual: modelsVisual, cta: "Compare the models" },
    { kicker: "Feature 2 of 4", tab: "collateral", title: "Know which collateral actually works",
      body: () => "An asset that shows up in every journey earns credit under every model, whether it helps or not. Lift asks a harder question: is a touch with this asset followed by the next stage more often than a comparable touch without it? Every asset gets a verdict, judged at the stage it was built for.",
      visual: collateralVisual, cta: "Open the collateral scorecard" },
    { kicker: "Feature 3 of 4", tab: "postsale", title: "Credit for the revenue after the sale",
      body: (x) => `Renewal, upsell and expansion each get their own attribution, and only touches after the original close compete for it. Presale campaigns can't claim retention revenue, and customer marketing gets measured on the ${fmt$(x.k.postsaleValue)} it keeps and grows.`,
      visual: postsaleVisual, cta: "See postsale attribution" },
    { kicker: "Feature 4 of 4", tab: "optimization", title: "Turn the numbers into a plan",
      body: () => "The Optimization tab ranks what to change: assets to retire, channels that cost too much per SQL, data problems that skew credit. One click builds an editable PowerPoint readout for leadership.",
      visual: optimizationVisual, cta: "Go to Optimization" },
  ];

  const root = document.createElement("div");
  root.className = "tour";
  root.hidden = true;
  root.innerHTML = `<div class="tour-backdrop" data-close></div>
  <div class="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
    <div class="tour-bar"><span class="tour-kicker" id="tour-kicker"></span><button class="tour-x" type="button" data-close aria-label="Close the tour">×</button></div>
    <div class="tour-visual" id="tour-visual"></div>
    <div class="tour-copy"><h2 id="tour-title"></h2><p id="tour-body"></p><button class="tour-cta" type="button" id="tour-cta" data-close hidden></button></div>
    <div class="tour-foot"><ol class="tour-steps" id="tour-steps" aria-label="Tour steps"></ol>
      <div class="tour-buttons"><button class="btn" type="button" id="tour-back"></button><button class="btn primary" type="button" id="tour-next"></button></div></div>
    <p class="visually-hidden" aria-live="polite" id="tour-status"></p>
  </div>`;
  document.body.appendChild(root);
  const q = (id) => root.querySelector("#" + id);
  const dialog = root.querySelector(".tour-dialog");
  q("tour-steps").innerHTML = steps.map((s, i) => `<li><button type="button" data-step="${i}" aria-label="${i ? esc(s.title) : "Intro"}"></button></li>`).join("");
  let cur = 0, opener = null;

  function draw() {
    f ??= facts(E);
    const s = steps[cur], last = cur === steps.length - 1;
    dialog.classList.toggle("is-intro", !!s.intro);
    q("tour-kicker").textContent = s.kicker;
    q("tour-title").textContent = s.title;
    q("tour-body").innerHTML = s.body(f);
    q("tour-visual").innerHTML = s.visual(f);
    q("tour-cta").hidden = !s.cta;
    if (s.cta) q("tour-cta").textContent = s.cta + " →";
    q("tour-back").textContent = s.intro ? "Skip, I'll explore" : "Back";
    q("tour-next").textContent = s.intro ? "Show me around" : last ? "Start exploring" : "Next";
    q("tour-steps").querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-current", i === cur ? "step" : "false"));
    q("tour-status").textContent = s.intro ? "" : `${s.kicker}: ${s.title}`;
    if (location.hash.slice(1) !== s.tab) history.replaceState(null, "", "#" + s.tab), dispatchEvent(new HashChangeEvent("hashchange"));
    dialog.scrollTop = 0;
  }
  function open() {
    opener = document.activeElement;
    cur = 0;
    draw();
    root.hidden = false;
    document.documentElement.classList.add("tour-on");
    q("tour-next").focus({ preventScroll: true });
  }
  function close() {
    markSeen();
    root.hidden = true;
    document.documentElement.classList.remove("tour-on");
    if (opener && document.contains(opener)) opener.focus();
  }
  const go = (i) => { cur = Math.max(0, Math.min(steps.length - 1, i)); draw(); };

  q("tour-next").onclick = () => (cur === steps.length - 1 ? close() : go(cur + 1));
  q("tour-back").onclick = () => (steps[cur].intro ? close() : go(cur - 1));
  q("tour-steps").onclick = (e) => { const b = e.target.closest("[data-step]"); if (b) go(+b.dataset.step); };
  root.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); if (cur < steps.length - 1) go(cur + 1); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(cur - 1); return; }
    if (e.key !== "Tab") return;
    const els = [...dialog.querySelectorAll("button")].filter((b) => !b.hidden && b.offsetParent !== null);
    if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0].focus(); }
  });
  document.querySelectorAll("[data-tour-open]").forEach((b) => b.addEventListener("click", open));
  if (new URLSearchParams(location.search).has("tour") || !seen()) open();
}
