// Leadership readout deck, built in the browser with PptxGenJS (vendored).
// Every chart and table is a native PowerPoint object, so it stays editable.
import { STAGES, STAGE, MODELS, STATUS } from "./engine.js";

const C = { ink: "15171B", ink2: "4C4B48", muted: "7D7C77", line: "E0DFDA", bg: "FFFFFF", soft: "F4F4F1", accent: "2A78D6", accentDark: "1C5CAB", good: "0CA30C", warn: "FAB219", crit: "D03B3B", neutral: "A8A7A1" };
const STATUS_COLOR = { double_down: C.good, amplify: C.accent, fix: C.warn, kill: C.crit, insufficient: C.neutral };
const FONT = "Arial";
const W = 13.333, H = 7.5;

export async function buildDeck(E, s) {
  const { opts, fmt$, fmtN, pct } = s;
  const pptx = new window.PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Full-Funnel Attribution";
  pptx.company = "Acme Corp";
  pptx.title = "Marketing attribution readout";
  const period = E.periods[s.period];
  const model = MODELS.find((m) => m.id === s.model);
  const k = E.kpis(period.range);
  const sc = E.scorecard();
  const sugg = E.suggestions(opts);
  const eff = E.efficiency(opts);
  const ps = E.postsale(period.range);
  const p = E.plg(period.range);
  let n = 0;

  const base = (title, kicker) => {
    const sl = pptx.addSlide();
    sl.background = { color: C.bg };
    n++;
    if (kicker) sl.addText(kicker.toUpperCase(), { x: 0.6, y: 0.35, w: 9, h: 0.3, fontFace: FONT, fontSize: 10, bold: true, color: C.accent, charSpacing: 1.5 });
    sl.addText(title, { x: 0.6, y: 0.62, w: W - 1.2, h: 0.8, fontFace: FONT, fontSize: 26, bold: true, color: C.ink, valign: "top", fit: "shrink" });
    sl.addShape(pptx.ShapeType.line, { x: 0.6, y: H - 0.5, w: W - 1.2, h: 0, line: { color: C.line, width: 0.75 } });
    sl.addText(`Acme Corp · Attribution readout · ${period.label} · ${model.label}`, { x: 0.6, y: H - 0.45, w: 10, h: 0.3, fontFace: FONT, fontSize: 9, color: C.muted });
    sl.addText(String(n), { x: W - 1.1, y: H - 0.45, w: 0.5, h: 0.3, fontFace: FONT, fontSize: 9, color: C.muted, align: "right" });
    return sl;
  };
  const statBox = (sl, x, y, w, label, value, sub, color = C.ink) => {
    sl.addShape(pptx.ShapeType.rect, { x, y, w, h: 1.25, fill: { color: C.soft }, line: { color: C.soft } });
    sl.addText(label, { x: x + 0.18, y: y + 0.12, w: w - 0.3, h: 0.28, fontFace: FONT, fontSize: 11, color: C.ink2 });
    sl.addText(value, { x: x + 0.18, y: y + 0.4, w: w - 0.3, h: 0.5, fontFace: FONT, fontSize: 26, bold: true, color });
    if (sub) sl.addText(sub, { x: x + 0.18, y: y + 0.88, w: w - 0.3, h: 0.3, fontFace: FONT, fontSize: 9.5, color: C.muted, fit: "shrink" });
  };

  // 1. Title ---------------------------------------------------------------
  {
    const sl = pptx.addSlide();
    n++;
    sl.background = { color: C.ink };
    [3.0, 2.2, 1.4, 0.8].forEach((h, i) => sl.addShape(pptx.ShapeType.rect, { x: 0.8 + i * 0.32, y: 2.6 - h, w: 0.22, h, fill: { color: C.accent, transparency: i * 18 }, line: { color: C.accent, transparency: 100 } }));
    sl.addText("Where our marketing works", { x: 0.8, y: 2.9, w: 11, h: 1, fontFace: FONT, fontSize: 40, bold: true, color: "FFFFFF" });
    sl.addText("Channel, collateral and postsale attribution readout", { x: 0.8, y: 3.85, w: 11, h: 0.5, fontFace: FONT, fontSize: 20, color: "C3C2B7" });
    sl.addText(`Acme Corp · ${period.label} · ${model.label} model · ${+s.lookback ? s.lookback + "-day" : "full-history"} lookback`, { x: 0.8, y: 4.6, w: 11, h: 0.4, fontFace: FONT, fontSize: 13, color: "8F8E88" });
    sl.addText(`Prepared ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} · Demo on synthetic data`, { x: 0.8, y: 6.6, w: 11, h: 0.3, fontFace: FONT, fontSize: 10, color: "8F8E88" });
  }

  // 2. Executive summary ---------------------------------------------------
  {
    const sqlAttr = E.attribute({ ...opts, stage: "sql" });
    const tot = sqlAttr.conversions - sqlAttr.unattributed;
    const topCh = sqlAttr.channels.map((c, i) => [c.credit, i]).sort((a, b) => b[0] - a[0])[0];
    const dd = sc.filter((a) => a.status === "double_down");
    const amp = sc.filter((a) => a.status === "amplify");
    const kill = sc.filter((a) => a.status === "kill");
    const fix = sc.filter((a) => a.status === "fix");
    const best = sugg.find((x) => x.kind === "channel_best");
    const costly = sugg.filter((x) => x.kind === "channel_cost");
    const total = k.wonValue + k.postsaleValue;
    const title = `${fmt$(total)} in new and postsale revenue on ${fmt$(k.spend)} of spend; ${amp.length + dd.length} assets earn more investment, ${kill.length + fix.length} don't`;
    const sl = base(title, "Executive summary");
    const bw = (W - 1.2 - 0.45) / 4;
    statBox(sl, 0.6, 1.65, bw, "New business won", fmt$(k.wonValue), `${fmtN(k.won)} deals · ${pct(k.winRate)} win rate`);
    statBox(sl, 0.6 + (bw + 0.15), 1.65, bw, "Postsale won", fmt$(k.postsaleValue), `renewal, upsell, expansion`, C.accentDark);
    statBox(sl, 0.6 + 2 * (bw + 0.15), 1.65, bw, "Marketing spend", fmt$(k.spend), `${(total / k.spend).toFixed(1)}x revenue ÷ spend`);
    statBox(sl, 0.6 + 3 * (bw + 0.15), 1.65, bw, "SQLs", fmtN(k.sql), `${fmtN(k.mql)} MQLs · ${fmtN(k.pql)} PQLs`);
    const bullets = [
      `${E.channels[topCh[1]].label} earns the most SQL credit: ${pct(topCh[0] / tot)} under ${model.label}.`,
      best ? `${best.title}: ${best.metric}.` : null,
      costly.length ? `${costly.map((c) => c.title.split(" costs")[0]).join(" and ")} cost${costly.length > 1 ? "" : "s"} far more per SQL than the median; judge them on later stages before cutting.` : null,
      dd.length ? `Double down on ${dd.map((a) => a.name).join(", ")}.` : null,
      amp.length ? `Amplify ${amp.map((a) => a.name).join(", ")}: proven lift, below-median reach.` : null,
      kill.length ? `Retire ${kill.length} assets with no measurable effect (${fmt$(kill.reduce((x, a) => x + a.production_cost, 0))} already spent producing them).` : null,
      ps.adoptedRate != null ? `Accounts with an activated user renew at ${pct(ps.adoptedRate)} vs ${pct(ps.notAdoptedRate)} without; adoption drives postsale revenue.` : null,
    ].filter(Boolean);
    sl.addText(bullets.map((b) => ({ text: b, options: { bullet: { code: "25A0" }, paraSpaceAfter: 6 } })), { x: 0.6, y: 3.15, w: W - 1.2, h: 3.7, fontFace: FONT, fontSize: 14, color: C.ink, valign: "top", fit: "shrink" });
  }

  // 3. Funnel --------------------------------------------------------------
  {
    const sl = base(`${fmtN(k.mql + k.pql)} leads became ${fmtN(k.opp)} opportunities and ${fmtN(k.won)} new customers`, "Funnel");
    sl.addChart(pptx.ChartType.bar, [{ name: "Conversions", labels: STAGES.map((x) => x.label), values: STAGES.map((x) => k[x.id]) }], {
      x: 0.6, y: 1.6, w: 7.6, h: 5.2, barDir: "col", chartColors: [C.accent], showValue: true, dataLabelFontSize: 10, dataLabelColor: C.ink2, dataLabelFontFace: FONT,
      catAxisLabelFontSize: 10, catAxisLabelFontFace: FONT, catAxisLabelColor: C.ink2, valAxisHidden: true, valGridLine: { style: "none" }, catAxisLineShow: false, barGapWidthPct: 60,
    });
    const rows = [
      ["MQL + PQL → SQL", pct(k.sql / Math.max(1, k.mql + k.pql))],
      ["MQL → SQL", pct(p.mqlToSql)],
      ["PQL → SQL", pct(p.pqlToSql)],
      ["Win rate (closed deals)", pct(k.winRate)],
      ["Renewal rate", pct(k.renewalRate)],
      ["Product signups activated", pct(p.activationRate)],
      ["PQL rate, activated vs not", `${pct(p.pqlRateActivated)} vs ${pct(p.pqlRateNotActivated)}`],
    ];
    sl.addTable(rows.map((r) => r.map((t, j) => ({ text: t, options: { fontFace: FONT, fontSize: 12, color: j ? C.ink : C.ink2, bold: !!j, align: j ? "right" : "left" } }))), { x: 8.6, y: 1.8, w: 4.1, colW: [2.6, 1.5], border: { type: "solid", color: C.line, pt: 0.5 }, rowH: 0.42 });
  }

  // 4. Channel credit -------------------------------------------------------
  {
    const sql = E.attribute({ ...opts, stage: "sql" });
    const ord = sql.channels.map((c, i) => ({ i, v: c.credit })).filter((x) => x.v > 0.5).sort((a, b) => a.v - b.v);
    const revRows = eff.map((r, i) => ({ i, v: r.revenue })).filter((x) => x.v > 0).sort((a, b) => a.v - b.v);
    const top = [...ord].reverse()[0];
    const sl = base(`${E.channels[top.i].label} leads SQL creation; customer channels carry postsale revenue`, "Channel credit");
    const opt = (color) => ({ barDir: "bar", chartColors: [color], showValue: true, dataLabelFontSize: 9, dataLabelFontFace: FONT, dataLabelColor: C.ink2, catAxisLabelFontSize: 9.5, catAxisLabelFontFace: FONT, catAxisLabelColor: C.ink2, valAxisHidden: true, valGridLine: { style: "none" }, barGapWidthPct: 45, showTitle: true, titleFontSize: 12, titleFontFace: FONT, titleColor: C.ink });
    sl.addChart(pptx.ChartType.bar, [{ name: "SQL credit", labels: ord.map((x) => E.channels[x.i].label), values: ord.map((x) => Math.round(x.v)) }], { x: 0.5, y: 1.55, w: 6.1, h: 5.3, ...opt(C.accent), title: `SQL credit (${model.short})` });
    sl.addChart(pptx.ChartType.bar, [{ name: "Revenue", labels: revRows.map((x) => E.channels[x.i].label), values: revRows.map((x) => Math.round(x.v / 1000)) }], { x: 6.8, y: 1.55, w: 6.1, h: 5.3, ...opt(C.accentDark), title: "Attributed revenue, new + postsale ($K)" });
  }

  // 5. Efficiency table ------------------------------------------------------
  {
    const rows = [...eff].filter((r) => r.cost > 0).sort((a, b) => (a.costPerSql ?? 1e12) - (b.costPerSql ?? 1e12));
    const sl = base("Cost per SQL ranges from " + fmt$(rows[0].costPerSql) + " to " + fmt$(rows.filter((r) => r.costPerSql).slice(-1)[0].costPerSql) + " across channels", "Efficiency");
    const head = ["Channel", "Spend", "SQL credit", "Opp credit", "Cost / SQL", "Revenue", "Revenue ÷ spend"].map((t, j) => ({ text: t, options: { bold: true, color: C.ink2, fontSize: 10.5, fontFace: FONT, align: j ? "right" : "left", fill: { color: C.soft } } }));
    const body = rows.map((r) => [r.label, fmt$(r.cost), fmtN(r.sql, 0), fmtN(r.opp, 0), fmt$(r.costPerSql), fmt$(r.revenue), r.roi == null ? "–" : r.roi.toFixed(1) + "x"].map((t, j) => ({ text: String(t), options: { fontSize: 10.5, fontFace: FONT, color: C.ink, align: j ? "right" : "left" } })));
    sl.addTable([head, ...body], { x: 0.6, y: 1.55, w: W - 1.2, colW: [3.4, 1.4, 1.4, 1.4, 1.4, 1.6, 1.53], border: { type: "solid", color: C.line, pt: 0.5 }, rowH: 0.36 });
  }

  // 6. Model disagreement ----------------------------------------------------
  {
    const ms = ["first", "last", "linear", "w_shaped", "markov"];
    const res = ms.map((m) => E.attribute({ ...opts, stage: "won", model: m }));
    const tot = Math.max(1, res[0].conversions - res[0].unattributed);
    const rows = E.channels.map((c, i) => ({ c, v: res.map((r) => r.channels[i].credit / tot) })).filter((x) => Math.max(...x.v) > 0.03).sort((a, b) => b.v[3] - a.v[3]).slice(0, 9);
    const spread = rows.map((x) => Math.max(...x.v) - Math.min(...x.v));
    const wide = rows[spread.indexOf(Math.max(...spread))];
    const sl = base(`The model changes the story: ${wide.c.label} earns ${pct(Math.min(...wide.v))} to ${pct(Math.max(...wide.v))} of closed-won credit`, "Why the model matters");
    const head = ["Channel", ...ms.map((m) => MODELS.find((x) => x.id === m).label)].map((t, j) => ({ text: t, options: { bold: true, color: C.ink2, fontSize: 10.5, fontFace: FONT, align: j ? "right" : "left", fill: { color: C.soft } } }));
    const body = rows.map((x) => [x.c.label, ...x.v.map((v) => pct(v))].map((t, j) => ({ text: t, options: { fontSize: 11, fontFace: FONT, color: C.ink, align: j ? "right" : "left", bold: j === 4 } })));
    sl.addTable([head, ...body], { x: 0.6, y: 1.55, w: W - 1.2, colW: [3.4, 1.7, 1.7, 1.7, 1.9, 1.73], border: { type: "solid", color: C.line, pt: 0.5 }, rowH: 0.38 });
    sl.addText("Share of closed-won deals credited to each channel. First touch rewards channels that open journeys; last touch rewards channels that close them. W-shaped is our default because it credits the first touch, lead creation and opportunity creation.", { x: 0.6, y: H - 1.35, w: W - 1.2, h: 0.7, fontFace: FONT, fontSize: 11, color: C.ink2 });
  }

  // 7. Collateral quadrant ---------------------------------------------------
  {
    const sl = base("Collateral: what to double down on, amplify, fix and kill", "Collateral scorecard");
    const px = 0.9, py = 1.6, pw = 7.6, ph = 5.1;
    sl.addShape(pptx.ShapeType.rect, { x: px, y: py, w: pw, h: ph, fill: { color: "FFFFFF" }, line: { color: C.line, width: 0.75 } });
    const maxR = Math.max(...sc.map((a) => a.contacts)) * 1.08;
    const X = (v) => px + Math.sqrt(v / maxR) * pw;
    const yMin = Math.log(0.5), yMax = Math.log(3);
    const Y = (v) => py + (1 - (Math.log(Math.min(Math.max(v, 0.5), 3)) - yMin) / (yMax - yMin)) * ph;
    const med = sc[0].medianReach;
    sl.addShape(pptx.ShapeType.line, { x: X(med), y: py, w: 0, h: ph, line: { color: C.muted, width: 0.75, dashType: "dash" } });
    sl.addShape(pptx.ShapeType.line, { x: px, y: Y(1.2), w: pw, h: 0, line: { color: C.muted, width: 0.75, dashType: "dash" } });
    sl.addShape(pptx.ShapeType.line, { x: px, y: Y(1), w: pw, h: 0, line: { color: C.ink2, width: 0.75 } });
    [0.5, 1, 1.5, 2, 3].forEach((t) => sl.addText(t + "x", { x: px - 0.55, y: Y(t) - 0.12, w: 0.48, h: 0.24, fontFace: FONT, fontSize: 9, color: C.muted, align: "right" }));
    sl.addText("Reach (contacts) →", { x: px, y: py + ph + 0.05, w: pw, h: 0.25, fontFace: FONT, fontSize: 9, color: C.muted, align: "right" });
    sl.addText("Lift ↑", { x: px - 0.6, y: py - 0.32, w: 1, h: 0.25, fontFace: FONT, fontSize: 9, color: C.muted });
    const ql = (t, x, y, color, align) => sl.addText(t.toUpperCase(), { x, y, w: 2.6, h: 0.25, fontFace: FONT, fontSize: 9, bold: true, color, align, charSpacing: 1 });
    ql("Double down", px + pw - 2.7, py + 0.08, C.good, "right");
    ql("Amplify", px + 0.1, py + 0.08, C.accent, "left");
    ql("Fix or replace", px + pw - 2.7, py + ph - 0.33, "8A5A00", "right");
    ql("Kill", px + 0.1, py + ph - 0.33, C.crit, "left");
    for (const a of sc) {
      const top = a.best || a.worst;
      const lift = top ? top.lift : Math.exp(((a.id.charCodeAt(2) % 5) - 2) * 0.012);
      const cx = X(a.contacts), cy = Y(lift);
      sl.addShape(pptx.ShapeType.ellipse, { x: cx - 0.09, y: cy - 0.09, w: 0.18, h: 0.18, fill: { color: STATUS_COLOR[a.status] }, line: { color: "FFFFFF", width: 1 } });
      if (["double_down", "amplify"].includes(a.status)) sl.addText(a.name.replace(/^(Customer story|Webinar|In-app guide|In-app promo|Infographic): /, "").slice(0, 28), { x: cx > px + pw * 0.7 ? cx - 2.35 : cx + 0.12, y: cy - 0.12, w: 2.2, h: 0.24, fontFace: FONT, fontSize: 8, color: C.ink2, align: cx > px + pw * 0.7 ? "right" : "left" });
    }
    const lines = [];
    for (const st of ["double_down", "amplify", "fix", "kill"]) {
      const xs = sc.filter((a) => a.status === st);
      lines.push({ text: `${STATUS[st].label} (${xs.length})`, options: { bold: true, color: STATUS_COLOR[st] === C.warn ? "8A5A00" : STATUS_COLOR[st], fontSize: 12, breakLine: true, paraSpaceBefore: 6 } });
      xs.slice(0, 6).forEach((a) => lines.push({ text: `${a.name}${a.best ? ` · ${a.best.lift.toFixed(1)}x ${STAGE[a.best.stage].label}` : ""}`, options: { fontSize: 9.5, color: C.ink, breakLine: true } }));
      if (xs.length > 6) lines.push({ text: `+${xs.length - 6} more`, options: { fontSize: 9.5, color: C.muted, breakLine: true } });
    }
    sl.addText(lines, { x: 8.85, y: 1.5, w: 3.9, h: 5.4, fontFace: FONT, valign: "top", fit: "shrink" });
  }

  // 8. Postsale -------------------------------------------------------------
  {
    const sl = base(`Postsale attribution: ${fmt$(k.postsaleValue)} from renewal, upsell and expansion`, "Postsale attribution");
    const bw = (W - 1.2 - 0.3) / 3;
    statBox(sl, 0.6, 1.6, bw, "Renewals", fmt$(k.renewalValue), `${pct(k.renewalRate)} renewal rate · ${pct(ps.grossRetention)} gross retention`, C.accentDark);
    statBox(sl, 0.6 + bw + 0.15, 1.6, bw, "Upsell", fmt$(k.upsellValue), `${fmtN(k.upsell)} deals`, C.accentDark);
    statBox(sl, 0.6 + 2 * (bw + 0.15), 1.6, bw, "Expansion", fmt$(k.expansionValue), `${fmtN(k.expansion)} deals`, C.accentDark);
    ["renewal", "upsell", "expansion"].forEach((st, j) => {
      const r = E.attribute({ ...opts, stage: st });
      const rows = r.channels.map((c, i) => ({ i, v: c.value })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 5);
      const data = [[{ text: "Channel", options: { bold: true, color: C.ink2, fill: { color: C.soft } } }, { text: "Revenue", options: { bold: true, color: C.ink2, align: "right", fill: { color: C.soft } } }],
        ...rows.map((x) => [{ text: E.channels[x.i].label }, { text: fmt$(x.v), options: { align: "right" } }])];
      sl.addTable(data, { x: 0.6 + j * (bw + 0.15), y: 3.1, w: bw, colW: [bw - 1.2, 1.2], fontFace: FONT, fontSize: 10.5, color: C.ink, border: { type: "solid", color: C.line, pt: 0.5 }, rowH: 0.34 });
    });
    const postWin = sc.filter((a) => a.rows.some((r) => STAGE[r.stage].phase === "postsale" && r.sig && r.lift > 1));
    sl.addText([
      { text: "Only customer-phase touches count toward postsale credit. ", options: { bold: true } },
      { text: `Accounts with an activated user renew at ${pct(ps.adoptedRate)} vs ${pct(ps.notAdoptedRate)} without.${postWin.length ? " Customer assets with proven lift: " + postWin.map((a) => a.name).join(", ") + "." : ""}` },
    ], { x: 0.6, y: 5.45, w: W - 1.2, h: 1.1, fontFace: FONT, fontSize: 12, color: C.ink2, valign: "top" });
  }

  // 9. Recommendations -------------------------------------------------------
  {
    const top = sugg.filter((x) => x.severity !== "info").slice(0, 6);
    const sl = base("Recommendations", "What we'll do next");
    const colW = (W - 1.2 - 0.3) / 2;
    top.forEach((r, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 0.6 + col * (colW + 0.3), y = 1.55 + row * 1.75;
      const color = { critical: C.crit, warning: C.warn, opportunity: C.accent, good: C.good }[r.severity] || C.neutral;
      sl.addShape(pptx.ShapeType.rect, { x, y, w: 0.07, h: 1.55, fill: { color }, line: { color } });
      sl.addText(r.title, { x: x + 0.2, y, w: colW - 0.25, h: 0.5, fontFace: FONT, fontSize: 13, bold: true, color: C.ink, valign: "top", fit: "shrink" });
      sl.addText(r.detail.length > 260 ? r.detail.slice(0, 257).replace(/\s+\S*$/, "") + "…" : r.detail, { x: x + 0.2, y: y + 0.5, w: colW - 0.25, h: 1.05, fontFace: FONT, fontSize: 9.5, color: C.ink2, valign: "top", fit: "shrink" });
    });
  }

  // 10. Method --------------------------------------------------------------
  {
    const sl = base("How to read these numbers", "Method and caveats");
    const h = E.hygiene(opts);
    const items = [
      ["Attribution", `${model.label}, ${+s.lookback ? s.lookback + "-day" : "full-history"} lookback. Opportunity and closed-won credit counts touches from every contact at the account. Postsale credit counts only touches after the customer's original close.`],
      ["Collateral lift", "Regularized logistic regression per stage, controlling for channel and engagement depth; Benjamini-Hochberg correction at a 10% false discovery rate. Assets are judged on the phase they were built for."],
      ["Offline touches", `Events, syndication and partner touches use the HubSpot record creation date. ${pct(h.lateShare)} of event touches were uploaded more than 3 days late (average ${h.avgLagDays.toFixed(0)} days), which understates event credit.`],
      ["Costs", "Campaign costs plus monthly program budgets. Syndication is billed per lead delivered."],
      ["Data", "This readout runs on the Full-Funnel Attribution demo dataset: synthetic Acme Corp data with known, planted effects."],
    ];
    sl.addTable(items.map(([a, b]) => [{ text: a, options: { bold: true, color: C.ink, fontSize: 12 } }, { text: b, options: { color: C.ink2, fontSize: 11.5 } }]), { x: 0.6, y: 1.6, w: W - 1.2, colW: [2.4, W - 3.6], fontFace: FONT, border: { type: "solid", color: C.line, pt: 0.5 }, valign: "top", margin: 0.1 });
  }

  void STAGES;
  return pptx.write({ outputType: "blob" });
}
