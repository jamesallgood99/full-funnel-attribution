/*
 * Full-Funnel Attribution engine.
 *
 * Pure functions over a normalized dataset (schema "ffa/1"): accounts, contacts
 * with lifecycle timestamps, deals, campaigns, assets, costs and touches. The
 * same dataset shape comes from the synthetic generator or the HubSpot
 * connector, so nothing here knows which one produced it.
 *
 * Runs in the browser (ES module) and in Node for tests.
 * Time unit: hours since meta.epoch.
 */

export const DAY = 24;

export const STAGES = [
  { id: "mql", label: "MQL", kind: "contact", phase: "presale", revenue: false },
  { id: "pql", label: "PQL", kind: "contact", phase: "presale", revenue: false },
  { id: "sql", label: "SQL", kind: "contact", phase: "presale", revenue: false },
  { id: "opp", label: "Opportunity", kind: "deal", phase: "presale", revenue: false },
  { id: "won", label: "Closed-won", kind: "deal", phase: "presale", revenue: true },
  { id: "renewal", label: "Renewal", kind: "deal", phase: "postsale", revenue: true },
  { id: "upsell", label: "Upsell", kind: "deal", phase: "postsale", revenue: true },
  { id: "expansion", label: "Expansion", kind: "deal", phase: "postsale", revenue: true },
];
export const STAGE = Object.fromEntries(STAGES.map((s) => [s.id, s]));
const STAGE_ORDER = { mql: 0, pql: 0, sql: 1, opp: 2, won: 3, renewal: 4, upsell: 4, expansion: 4 };

export const MODELS = [
  { id: "first", label: "First touch", short: "First" },
  { id: "last", label: "Last touch", short: "Last" },
  { id: "linear", label: "Linear", short: "Linear" },
  { id: "time_decay", label: "Time decay (7-day half-life)", short: "Decay" },
  { id: "u_shaped", label: "U-shaped (40/20/40)", short: "U" },
  { id: "w_shaped", label: "W-shaped (30/30/30/10)", short: "W" },
  { id: "markov", label: "Data-driven (Markov)", short: "Markov" },
];

export const STATUS = {
  double_down: { label: "Double down", order: 0 },
  amplify: { label: "Amplify", order: 1 },
  fix: { label: "Fix or replace", order: 2 },
  kill: { label: "Kill", order: 3 },
  insufficient: { label: "Not enough data", order: 4 },
};

// Touch-level lift horizon in days: "did the unit convert within H days of this touch?"
// Closed-won and renewal are judged at the deal level instead (exposed vs unexposed deals).
const LIFT_HORIZON = { mql: 7, pql: 7, sql: 10, opp: 14 };
const MIN_TOUCHES = 25;
const MIN_UNITS = 12;
const MIN_EXPECTED = 4;
const LATE_DAYS = 3;
const FDR = 0.1;
function normCdf(x) {
  // Abramowitz-Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function createEngine(raw) {
  const meta = raw.meta;
  const END = meta.days * DAY;
  const channels = raw.channels;
  const chIndex = Object.fromEntries(channels.map((c, i) => [c.id, i]));
  const assets = raw.assets;
  const campaigns = raw.campaigns;
  const contacts = raw.contacts;
  const deals = raw.deals;
  const accounts = raw.accounts;
  const acctIndex = Object.fromEntries(accounts.map((a, i) => [a.id, i]));
  const T = raw.touches;
  const N = T.t.length;
  const tContact = Int32Array.from(T.contact);
  const tChan = Int16Array.from(T.channel);
  const tAsset = Int16Array.from(T.asset);
  const tCamp = Int16Array.from(T.campaign);
  const tLogged = Float64Array.from(T.t);
  const tAcct = new Int32Array(N);
  const contactAcct = Int32Array.from(contacts.map((c) => acctIndex[c.account]));
  for (let i = 0; i < N; i++) tAcct[i] = contactAcct[tContact[i]];

  // Event-date alternative: offline event touches moved to the campaign's event date.
  const eventChan = new Set(channels.map((c, i) => (c.offline && c.id.startsWith("event") ? i : -1)).filter((i) => i >= 0));
  const tEvent = Float64Array.from(tLogged);
  const lateFlag = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (eventChan.has(tChan[i])) {
      const d = campaigns[tCamp[i]].date;
      if (d <= tLogged[i]) tEvent[i] = Math.max(d, contacts[tContact[i]].created);
      if (tLogged[i] - d > LATE_DAYS * DAY) lateFlag[i] = 1;
    }
  }

  function buildIndex(tArr) {
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => tArr[a] - tArr[b]);
    const byContact = contacts.map(() => []);
    const byAcct = accounts.map(() => []);
    for (const i of order) {
      byContact[tContact[i]].push(i);
      byAcct[tAcct[i]].push(i);
    }
    return { t: tArr, byContact, byAcct };
  }
  const idxCache = {};
  const index = (useEventDate) => (idxCache[useEventDate ? 1 : 0] ||= buildIndex(useEventDate ? tEvent : tLogged));

  const dealsByAcct = accounts.map(() => []);
  deals.forEach((d) => dealsByAcct[acctIndex[d.account]].push(d));
  const dealById = Object.fromEntries(deals.map((d) => [d.id, d]));
  const contactsByAcct = accounts.map(() => []);
  contacts.forEach((c, i) => contactsByAcct[contactAcct[i]].push(i));

  // helpers --------------------------------------------------------------
  function slice(list, tArr, from, to) {
    // touches with from <= t < to (list sorted by tArr)
    const out = [];
    for (const i of list) {
      const t = tArr[i];
      if (t < from) continue;
      if (t >= to) break;
      out.push(i);
    }
    return out;
  }
  const firstLeadTime = (ai) => {
    let m = Infinity;
    for (const ci of contactsByAcct[ai]) {
      const c = contacts[ci];
      for (const k of ["mql", "pql"]) if (c[k] != null && c[k] < m) m = c[k];
    }
    return m;
  };
  const firstSqlTime = (ai) => {
    let m = Infinity;
    for (const ci of contactsByAcct[ai]) if (contacts[ci].sql != null && contacts[ci].sql < m) m = contacts[ci].sql;
    return m;
  };
  const customerStart = (d) => (d.parent ? dealById[d.parent].closed : null);
  const acctCustomerSince = accounts.map((_, ai) => {
    let m = Infinity;
    for (const d of dealsByAcct[ai]) if (d.type === "new_business" && d.status === "won" && d.closed < m) m = d.closed;
    return m;
  });

  // ----------------------------------------------------------------------
  // Conversions for a stage: [{ts, value, touches:[idx], anchors:{lead, opp}}]
  // ----------------------------------------------------------------------
  function conversions(stage, { lookbackDays = 365, useEventDate = false } = {}) {
    const ix = index(useEventDate);
    const tArr = ix.t;
    const L = lookbackDays ? lookbackDays * DAY : Infinity;
    const out = [];
    if (STAGE[stage].kind === "contact") {
      contacts.forEach((c, ci) => {
        const ts = c[stage];
        if (ts == null) return;
        const touches = slice(ix.byContact[ci], tArr, ts - L, ts + 1e-6);
        let lead = null;
        if (stage === "sql") {
          const lt = Math.min(c.mql ?? Infinity, c.pql ?? Infinity);
          lead = lastBefore(touches, tArr, lt);
        }
        out.push({ ts, value: 1, unit: ci, touches, anchors: { lead } });
      });
    } else if (stage === "opp" || stage === "won") {
      for (const d of deals) {
        if (d.type !== "new_business") continue;
        if (stage === "won" && d.status !== "won") continue;
        const ts = stage === "opp" ? d.created : d.closed;
        const ai = acctIndex[d.account];
        const touches = slice(ix.byAcct[ai], tArr, ts - L, ts + 1e-6);
        const lead = lastBefore(touches, tArr, firstLeadTime(ai));
        const opp = stage === "won" ? lastBefore(touches, tArr, d.created) : null;
        out.push({ ts, value: stage === "won" ? d.amount : 1, amount: d.amount, unit: d.id, touches, anchors: { lead, opp } });
      }
    } else {
      for (const d of deals) {
        if (d.type !== stage || d.status !== "won") continue;
        const ai = acctIndex[d.account];
        const start = customerStart(d);
        const touches = slice(ix.byAcct[ai], tArr, Math.max(start, d.closed - L), d.closed + 1e-6);
        out.push({ ts: d.closed, value: d.amount, amount: d.amount, unit: d.id, touches, anchors: {} });
      }
    }
    return out;
  }
  function lastBefore(touches, tArr, ts) {
    let r = null;
    for (const i of touches) if (tArr[i] <= ts) r = i;
    return r;
  }

  // credit weights for one conversion's ordered touches
  function weights(model, conv, tArr, stage) {
    const tt = conv.touches;
    const n = tt.length;
    if (!n) return [];
    const w = new Array(n).fill(0);
    if (model === "first") w[0] = 1;
    else if (model === "last") w[n - 1] = 1;
    else if (model === "linear") w.fill(1 / n);
    else if (model === "time_decay") {
      let s = 0;
      for (let k = 0; k < n; k++) s += w[k] = Math.pow(2, -(conv.ts - tArr[tt[k]]) / (7 * DAY));
      for (let k = 0; k < n; k++) w[k] /= s;
    } else if (model === "u_shaped" || (model === "w_shaped" && STAGE[stage].phase === "postsale") || (model === "w_shaped" && (stage === "mql" || stage === "pql"))) {
      uShape(w, n);
    } else if (model === "w_shaped") {
      // anchors: first touch, lead-creation touch, opportunity-creation touch (or last touch for SQL/Opp)
      const anchors = [0];
      const leadPos = conv.anchors.lead != null ? tt.indexOf(conv.anchors.lead) : -1;
      anchors.push(leadPos >= 0 ? leadPos : -1);
      const oppPos = conv.anchors.opp != null ? tt.indexOf(conv.anchors.opp) : n - 1;
      anchors.push(oppPos);
      const valid = [...new Set(anchors.filter((a) => a >= 0))];
      if (n === 1) w[0] = 1;
      else {
        const anchorShare = valid.length === 3 ? 0.3 : 0.45;
        valid.forEach((a) => (w[a] += anchorShare));
        const rest = 1 - anchorShare * valid.length;
        const others = [];
        for (let k = 0; k < n; k++) if (!valid.includes(k)) others.push(k);
        if (others.length) others.forEach((k) => (w[k] += rest / others.length));
        else valid.forEach((a) => (w[a] += rest / valid.length));
      }
    }
    return w;
  }
  function uShape(w, n) {
    if (n === 1) w[0] = 1;
    else if (n === 2) (w[0] = 0.5), (w[1] = 0.5);
    else {
      w[0] = 0.4;
      w[n - 1] = 0.4;
      for (let k = 1; k < n - 1; k++) w[k] = 0.2 / (n - 2);
    }
  }

  const inPeriod = (ts, p) => ts >= p[0] && ts < p[1];
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };

  // ----------------------------------------------------------------------
  function attribute(o) {
    const opts = { stage: "sql", model: "w_shaped", lookbackDays: 365, period: [0, END], useEventDate: false, ...o };
    const key = "attr|" + JSON.stringify(opts);
    return memo(key, () => {
      const { stage, model, period } = opts;
      if (model === "markov") return markovAttribute(opts);
      const tArr = index(opts.useEventDate).t;
      const convs = conversions(stage, opts).filter((c) => inPeriod(c.ts, period));
      const ch = channels.map(() => ({ credit: 0, value: 0 }));
      const as = assets.map(() => ({ credit: 0, value: 0 }));
      const cp = campaigns.map(() => ({ credit: 0, value: 0 }));
      let unattributed = 0;
      let totalValue = 0;
      for (const c of convs) {
        totalValue += c.value;
        if (!c.touches.length) {
          unattributed += 1;
          continue;
        }
        const w = weights(model, c, tArr, stage);
        c.touches.forEach((ti, k) => {
          if (!w[k]) return;
          ch[tChan[ti]].credit += w[k];
          ch[tChan[ti]].value += w[k] * c.value;
          cp[tCamp[ti]].credit += w[k];
          cp[tCamp[ti]].value += w[k] * c.value;
          if (tAsset[ti] >= 0) {
            as[tAsset[ti]].credit += w[k];
            as[tAsset[ti]].value += w[k] * c.value;
          }
        });
      }
      return { ...opts, conversions: convs.length, totalValue, unattributed, channels: ch, assets: as, campaigns: cp };
    });
  }

  // ----------------------------------------------------------------------
  // Markov (first-order, channel states, removal effect)
  // ----------------------------------------------------------------------
  function units(stage, { lookbackDays = 365, useEventDate = false } = {}) {
    // every unit eligible for the stage, converted or not, with its touch path
    const ix = index(useEventDate);
    const tArr = ix.t;
    const L = lookbackDays ? lookbackDays * DAY : Infinity;
    const out = [];
    const push = (list, from, conv, censor, extra) => {
      const to = conv ?? censor;
      out.push({ conv, touches: slice(list, tArr, Math.max(from, to - L), to + 1e-6), from, to, ...extra });
    };
    if (stage === "mql" || stage === "pql") {
      contacts.forEach((c, ci) => {
        if ((stage === "pql") !== (c.path === "plg")) return;
        push(ix.byContact[ci], c.created, c[stage], Math.min(c.sql ?? END, acctCustomerSince[contactAcct[ci]], END), { unit: ci });
      });
    } else if (stage === "sql") {
      contacts.forEach((c, ci) => {
        const lt = Math.min(c.mql ?? Infinity, c.pql ?? Infinity);
        if (lt === Infinity) return;
        push(ix.byContact[ci], c.created, c.sql, Math.min(END, acctCustomerSince[contactAcct[ci]]), { unit: ci, start: lt });
      });
    } else if (stage === "opp") {
      accounts.forEach((a, ai) => {
        const s = firstSqlTime(ai);
        if (s === Infinity) return;
        const d = dealsByAcct[ai].find((x) => x.type === "new_business");
        push(ix.byAcct[ai], 0, d ? d.created : null, END, { unit: ai, start: s });
      });
    } else if (stage === "won") {
      for (const d of deals) {
        if (d.type !== "new_business" || d.status === "open" || d.created < 0) continue;
        push(ix.byAcct[acctIndex[d.account]], 0, d.status === "won" ? d.closed : null, d.closed, { unit: d.id, start: d.created });
      }
    } else if (stage === "renewal") {
      for (const d of deals) {
        if (d.type !== "renewal") continue;
        const s = customerStart(d);
        push(ix.byAcct[acctIndex[d.account]], s, d.status === "won" ? d.closed : null, d.closed, { unit: d.id, start: s });
      }
    } else {
      for (const d of deals) {
        if (d.type !== "new_business" || d.status !== "won") continue;
        const ai = acctIndex[d.account];
        const first = dealsByAcct[ai].filter((x) => x.type === stage && x.parent === d.id).sort((a, b) => a.closed - b.closed)[0];
        push(ix.byAcct[ai], d.closed, first ? first.closed : null, Math.min(END, d.closed + 365 * DAY), { unit: d.id, start: d.closed });
      }
    }
    return out;
  }

  function markovEffects(stage, opts) {
    return memo("mk|" + stage + "|" + opts.lookbackDays + "|" + opts.useEventDate, () => {
      const us = units(stage, opts);
      const C = channels.length;
      const S = C + 3; // channels, START, CONV, NULL
      const START = C, CONV = C + 1, NULL = C + 2;
      const counts = Array.from({ length: S }, () => new Float64Array(S));
      let nConv = 0;
      for (const u of us) {
        const seq = [];
        for (const ti of u.touches) {
          const c = tChan[ti];
          if (seq[seq.length - 1] !== c) seq.push(c);
        }
        let prev = START;
        for (const c of seq) {
          counts[prev][c] += 1;
          prev = c;
        }
        counts[prev][u.conv != null ? CONV : NULL] += 1;
        if (u.conv != null) nConv++;
      }
      const P = counts.map((row) => {
        const s = row.reduce((a, b) => a + b, 0);
        return s ? Array.from(row, (v) => v / s) : null;
      });
      const pConv = (removed) => {
        const v = new Float64Array(S);
        v[CONV] = 1;
        for (let it = 0; it < 200; it++) {
          let delta = 0;
          for (let s = 0; s < S; s++) {
            if (s === CONV || s === NULL || s === removed || !P[s]) continue;
            let x = 0;
            const row = P[s];
            for (let k = 0; k < S; k++) if (row[k]) x += row[k] * (k === removed ? 0 : v[k]);
            delta = Math.max(delta, Math.abs(x - v[s]));
            v[s] = x;
          }
          if (delta < 1e-10) break;
        }
        return v[START];
      };
      const base = pConv(-1);
      const re = channels.map((_, c) => (base > 0 ? Math.max(0, 1 - pConv(c) / base) : 0));
      const sum = re.reduce((a, b) => a + b, 0) || 1;
      return { base, units: us.length, converted: nConv, removal: re, share: re.map((r) => r / sum) };
    });
  }

  function markovAttribute(opts) {
    const mk = markovEffects(opts.stage, opts);
    const lin = attribute({ ...opts, model: "linear" });
    const total = lin.conversions - lin.unattributed;
    const linShareTotal = lin.conversions ? (lin.totalValue * (lin.conversions - lin.unattributed)) / lin.conversions : 0;
    const ch = channels.map((_, c) => ({ credit: mk.share[c] * total, value: mk.share[c] * linShareTotal }));
    // assets: split each channel's Markov credit by the asset mix that channel carried under linear
    const chLinCredit = lin.channels.map((x) => x.credit);
    const as = assets.map(() => ({ credit: 0, value: 0 }));
    const cp = campaigns.map(() => ({ credit: 0, value: 0 }));
    const tArr = index(opts.useEventDate).t;
    const convs = conversions(opts.stage, opts).filter((c) => inPeriod(c.ts, opts.period));
    for (const c of convs) {
      const n = c.touches.length;
      for (const ti of c.touches) {
        const chn = tChan[ti];
        if (!chLinCredit[chn]) continue;
        const f = 1 / n / chLinCredit[chn];
        if (tAsset[ti] >= 0) {
          as[tAsset[ti]].credit += f * ch[chn].credit;
          as[tAsset[ti]].value += f * ch[chn].value;
        }
        cp[tCamp[ti]].credit += f * ch[chn].credit;
        cp[tCamp[ti]].value += f * ch[chn].value;
      }
    }
    void tArr;
    return { ...opts, conversions: lin.conversions, totalValue: lin.totalValue, unattributed: lin.unattributed, channels: ch, assets: as, campaigns: cp, markov: mk };
  }

  // ----------------------------------------------------------------------
  // Collateral lift: touch-level conversion rate vs other touches in the same
  // channel (stratified by channel, so channel strength and engagement volume
  // don't masquerade as asset quality).
  // ----------------------------------------------------------------------
  // Collateral lift. A regularized logistic regression per stage separates each
  // asset's effect from its channel, from co-occurring assets and from how
  // engaged the buyer already is.
  //  - MQL, PQL, SQL, Opportunity: touch level. Outcome = the contact/account
  //    reached the stage within H days of the touch. Controls: channel, touch depth.
  //  - Closed-won, renewal, upsell, expansion: deal/customer level. Outcome =
  //    converted. Controls: touch-volume bucket, channels present.
  // Reported lift = predicted conversions of exposed units with the asset
  // divided by the same units' predicted conversions without it.
  function lift() {
    return memo("lift", () => {
      const result = {};
      const tArr = tLogged;
      const C = channels.length, A = assets.length;
      for (const s of STAGES) {
        const H = LIFT_HORIZON[s.id];
        const us = units(s.id, { lookbackDays: 0 });
        const X = [], y = [], unitOf = [];
        if (H != null) {
          // features: [0..C) channel, [C..C+4) depth bucket, [C+4..C+4+A) asset
          us.forEach((u, ui) => {
            const start = u.start ?? u.from;
            let depth = 0;
            for (const ti of u.touches) {
              const t = tArr[ti];
              if (t < start) continue;
              if (u.conv != null && t >= u.conv) break;
              depth++;
              if (u.conv == null && t + H * DAY > Math.min(END, u.to)) continue;
              const f = [tChan[ti], C + (depth === 1 ? 0 : depth <= 3 ? 1 : depth <= 7 ? 2 : 3)];
              if (tAsset[ti] >= 0) f.push(C + 4 + tAsset[ti]);
              X.push(f);
              y.push(u.conv != null && u.conv - t <= H * DAY ? 1 : 0);
              unitOf.push(ui);
            }
          });
        } else {
          // features: [0..C) channel present, [C..C+5) touch-volume bucket, [C+5..) asset seen
          us.forEach((u, ui) => {
            const start = u.start ?? u.from;
            const ch = new Set(), as = new Map();
            let n = 0;
            for (const ti of u.touches) {
              if (tArr[ti] < start) continue;
              n++;
              ch.add(tChan[ti]);
              if (tAsset[ti] >= 0) as.set(tAsset[ti], (as.get(tAsset[ti]) || 0) + 1);
            }
            const b = n <= 3 ? 0 : n <= 7 ? 1 : n <= 12 ? 2 : n <= 20 ? 3 : 4;
            // closed-won and renewal: exposure (seen or not); upsell and expansion: dose (log touches)
            const dose = s.id === "upsell" || s.id === "expansion";
            X.push([...ch, C + b, ...[...as.entries()].map(([a, k]) => [C + 5 + a, dose ? Math.log1p(k) : 1])]);
            y.push(u.conv != null ? 1 : 0);
            unitOf.push(ui);
          });
        }
        const off = H != null ? C + 4 : C + 5;
        const fit = logistic(X, y, off + A);
        const rows = assets.map((asset, a) => {
          const j = off + a;
          let n = 0, obs = 0, p1 = 0, p0 = 0;
          const seen = new Set();
          for (let r = 0; r < X.length; r++) {
            const f = X[r].find((e) => (Array.isArray(e) ? e[0] : e) === j);
            if (f == null) continue;
            const val = Array.isArray(f) ? f[1] : 1;
            n++;
            obs += y[r];
            seen.add(unitOf[r]);
            const eta = fit.eta[r];
            p1 += 1 / (1 + Math.exp(-eta));
            p0 += 1 / (1 + Math.exp(-(eta - fit.beta[j] * val)));
          }
          const minN = H != null ? MIN_TOUCHES : MIN_UNITS;
          const ok = n >= minN && p0 >= (H != null ? MIN_EXPECTED : 3);
          const z = fit.se[j] > 0 ? fit.beta[j] / fit.se[j] : 0;
          return {
            p: 2 * (1 - normCdf(Math.abs(z))),
            asset: asset.id, stage: s.id, method: H != null ? "touch" : "deal",
            touches: n, units: seen.size, converted: obs, expected: p0,
            lift: p0 > 0 ? p1 / p0 : null, oddsRatio: Math.exp(fit.beta[j]), z, enough: ok, sig: false,
          };
        });
        result[s.id] = rows;
      }
      // Benjamini-Hochberg false-discovery control across every asset x stage test
      const all = Object.values(result).flat().filter((r) => r.enough).sort((a, b) => a.p - b.p);
      let cutoff = -1;
      all.forEach((r, i) => { if (r.p <= ((i + 1) / all.length) * FDR) cutoff = i; });
      all.forEach((r, i) => { r.sig = i <= cutoff; });
      return result;
    });
  }

  // L2-regularized logistic regression on sparse features (Newton/IRLS).
  // Each row is a list of feature indices (value 1) or [index, value] pairs.
  function logistic(Xin, y, P, lambda = 1, iters = 12) {
    const X = Xin.map((row) => row.map((e) => (Array.isArray(e) ? e : [e, 1])));
    const D = P + 1; // + intercept at index P
    const beta = new Float64Array(D);
    const meanY = y.reduce((a, b) => a + b, 0) / (y.length || 1);
    beta[P] = Math.log((meanY + 1e-6) / (1 - meanY + 1e-6));
    let Hm;
    const eta = new Float64Array(X.length);
    for (let it = 0; it < iters; it++) {
      const g = new Float64Array(D);
      Hm = Array.from({ length: D }, () => new Float64Array(D));
      for (let r = 0; r < X.length; r++) {
        let e = beta[P];
        for (const [j, v] of X[r]) e += beta[j] * v;
        eta[r] = e;
        const p = 1 / (1 + Math.exp(-e));
        const w = p * (1 - p);
        const d = y[r] - p;
        const f = X[r];
        g[P] += d;
        Hm[P][P] += w;
        for (const [j, vj] of f) {
          g[j] += d * vj;
          Hm[P][j] += w * vj;
          Hm[j][P] += w * vj;
          for (const [k, vk] of f) Hm[j][k] += w * vj * vk;
        }
      }
      for (let j = 0; j < P; j++) {
        g[j] -= lambda * beta[j];
        Hm[j][j] += lambda;
      }
      const step = solve(Hm, g);
      let mx = 0;
      for (let j = 0; j < D; j++) {
        beta[j] += step[j];
        mx = Math.max(mx, Math.abs(step[j]));
      }
      if (mx < 1e-7) break;
    }
    for (let r = 0; r < X.length; r++) {
      let e = beta[P];
      for (const [j, v] of X[r]) e += beta[j] * v;
      eta[r] = e;
    }
    const inv = invert(Hm);
    const se = Array.from({ length: D }, (_, j) => Math.sqrt(Math.max(inv[j][j], 0)));
    return { beta, se, eta };
  }
  function solve(Ain, b) {
    const n = b.length;
    const A = Ain.map((r) => Float64Array.from(r));
    const x = Float64Array.from(b);
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]];
      [x[i], x[p]] = [x[p], x[i]];
      const d = A[i][i] || 1e-12;
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / d;
        if (!f) continue;
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        x[r] -= f * x[i];
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / (A[i][i] || 1e-12);
    }
    return x;
  }
  function invert(M) {
    const n = M.length;
    return Array.from({ length: n }, (_, j) => {
      const e = new Float64Array(n);
      e[j] = 1;
      return solve(M, e);
    }).reduce((acc, col, j) => {
      col.forEach((v, i) => (acc[i][j] = v));
      return acc;
    }, Array.from({ length: n }, () => new Float64Array(n)));
  }

  function reach() {
    return memo("reach", () => {
      const sets = assets.map(() => new Set());
      const accts = assets.map(() => new Set());
      const touches = new Float64Array(assets.length);
      for (let i = 0; i < N; i++) {
        const a = tAsset[i];
        if (a < 0) continue;
        sets[a].add(tContact[i]);
        accts[a].add(tAcct[i]);
        touches[a]++;
      }
      return assets.map((_, a) => ({ contacts: sets[a].size, accounts: accts[a].size, touches: touches[a] }));
    });
  }

  function scorecard() {
    return memo("score", () => {
      const L = lift();
      const R = reach();
      const sortedReach = R.map((r) => r.contacts).sort((a, b) => a - b);
      const medianReach = sortedReach[Math.floor(sortedReach.length / 2)];
      return assets.map((asset, a) => {
        const rows = STAGES.map((s) => L[s.id][a]);
        // judge an asset on the phase it was built for (presale vs postsale)
        const phase = STAGE[asset.intended_stage].phase;
        const enough = rows.filter((r) => r.enough && STAGE[r.stage].phase === phase);
        const pos = enough.filter((r) => r.sig && r.z > 0 && r.lift >= 1.2).sort((x, y) => y.lift - x.lift);
        const neg = enough.filter((r) => r.sig && r.z < 0 && r.lift < 0.85).sort((x, y) => x.lift - y.lift);
        const best = pos[0] || null;
        const r = R[a];
        const high = r.contacts >= medianReach;
        let status;
        if (!enough.length) status = "insufficient";
        else if (best && !(neg[0] && neg[0].stage === "won")) status = high ? "double_down" : "amplify";
        else if (neg.length) status = "kill";
        else status = high ? "fix" : "kill";
        const mismatch = best && Math.abs(STAGE_ORDER[best.stage] - STAGE_ORDER[asset.intended_stage]) >= 2 ? best.stage : null;
        return { ...asset, ...r, rows, best, worst: neg[0] || null, status, mismatch, medianReach, highReach: high };
      });
    });
  }

  // ----------------------------------------------------------------------
  // Costs, KPIs, efficiency
  // ----------------------------------------------------------------------
  const monthOf = (h) => Math.min(23, Math.floor(h / DAY / 30.42));
  function costs(period) {
    const m0 = monthOf(period[0]), m1 = period[1] >= END ? 23 : monthOf(period[1] - 1);
    const by = channels.map(() => 0);
    for (const r of raw.costs) if (r.month >= m0 && r.month <= m1) by[chIndex[r.channel]] += r.cost;
    return by;
  }

  function kpis(period = [0, END]) {
    return memo("kpi|" + period, () => {
      const k = {};
      for (const s of ["mql", "pql", "sql"]) k[s] = contacts.filter((c) => c[s] != null && inPeriod(c[s], period)).length;
      const nb = deals.filter((d) => d.type === "new_business");
      k.opp = nb.filter((d) => inPeriod(d.created, period)).length;
      const closed = nb.filter((d) => d.closed != null && inPeriod(d.closed, period) && d.status !== "open");
      const won = closed.filter((d) => d.status === "won");
      k.won = won.length;
      k.wonValue = won.reduce((a, d) => a + d.amount, 0);
      k.winRate = closed.length ? won.length / closed.length : 0;
      k.pipeline = nb.filter((d) => inPeriod(d.created, period)).reduce((a, d) => a + d.amount, 0);
      for (const t of ["renewal", "upsell", "expansion"]) {
        const ds = deals.filter((d) => d.type === t && d.closed != null && inPeriod(d.closed, period));
        const w = ds.filter((d) => d.status === "won");
        k[t] = w.length;
        k[t + "Value"] = w.reduce((a, d) => a + d.amount, 0);
        if (t === "renewal") k.renewalRate = ds.length ? w.length / ds.length : null;
      }
      k.postsaleValue = k.renewalValue + k.upsellValue + k.expansionValue;
      k.signups = contacts.filter((c) => c.signup != null && inPeriod(c.signup, period)).length;
      k.activated = contacts.filter((c) => c.activated != null && inPeriod(c.activated, period)).length;
      k.spend = costs(period).reduce((a, b) => a + b, 0);
      k.contacts = contacts.filter((c) => inPeriod(c.created, period)).length;
      return k;
    });
  }

  function efficiency(o) {
    const opts = { model: "w_shaped", lookbackDays: 365, period: [0, END], useEventDate: false, ...o };
    return memo("eff|" + JSON.stringify(opts), () => {
      const cost = costs(opts.period);
      const per = {};
      for (const s of STAGES) per[s.id] = attribute({ ...opts, stage: s.id });
      return channels.map((c, i) => {
        const row = { id: c.id, label: c.label, group: c.group, cost: cost[i] };
        for (const s of STAGES) {
          row[s.id] = per[s.id].channels[i].credit;
          if (s.revenue) row[s.id + "Value"] = per[s.id].channels[i].value;
        }
        row.revenue = row.wonValue + row.renewalValue + row.upsellValue + row.expansionValue;
        row.costPerSql = row.sql > 0.5 ? cost[i] / row.sql : null;
        row.costPerOpp = row.opp > 0.5 ? cost[i] / row.opp : null;
        row.roi = cost[i] > 0 ? row.revenue / cost[i] : null;
        return row;
      });
    });
  }

  // ----------------------------------------------------------------------
  // Journeys
  // ----------------------------------------------------------------------
  function paths(stage, o) {
    const opts = { lookbackDays: 365, period: [0, END], useEventDate: false, ...o };
    return memo("paths|" + stage + JSON.stringify(opts), () => {
      const tArr = index(opts.useEventDate).t;
      const convs = conversions(stage, opts).filter((c) => inPeriod(c.ts, opts.period));
      const counts = new Map();
      const full = new Set();
      let touchSum = 0, daySum = 0, n = 0;
      for (const c of convs) {
        if (!c.touches.length) continue;
        const seq = [];
        for (const ti of c.touches) if (seq[seq.length - 1] !== tChan[ti]) seq.push(tChan[ti]);
        full.add(seq.join(">"));
        const key = (seq.length > 2 ? [seq[0], -1, seq[seq.length - 1]] : seq).join(">");
        counts.set(key, (counts.get(key) || 0) + 1);
        touchSum += c.touches.length;
        daySum += (c.ts - tArr[c.touches[0]]) / DAY;
        n++;
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([k, v]) => ({ steps: k.split(">").map(Number), count: v, share: v / (n || 1) }));
      return { conversions: n, avgTouches: n ? touchSum / n : 0, avgDays: n ? daySum / n : 0, distinctPaths: full.size, top };
    });
  }

  // ----------------------------------------------------------------------
  // Data hygiene: event touches logged late (record creation >> event date)
  // ----------------------------------------------------------------------
  function hygiene(o) {
    const opts = { model: "w_shaped", lookbackDays: 365, period: [0, END], ...o };
    return memo("hyg|" + JSON.stringify(opts), () => {
      let eventTouches = 0, late = 0, crossed = 0, lagSum = 0;
      const stageKeys = ["mql", "pql", "sql"];
      for (let i = 0; i < N; i++) {
        if (!eventChan.has(tChan[i]) || !inPeriod(tLogged[i], opts.period)) continue;
        eventTouches++;
        const d = campaigns[tCamp[i]].date;
        if (!lateFlag[i]) continue;
        late++;
        lagSum += (tLogged[i] - d) / DAY;
        const c = contacts[tContact[i]];
        let hit = stageKeys.some((k) => c[k] != null && c[k] > d && c[k] < tLogged[i]);
        if (!hit) for (const dl of dealsByAcct[tAcct[i]]) if (dl.created > d && dl.created < tLogged[i]) hit = true;
        if (hit) crossed++;
      }
      const impact = ["sql", "opp", "won"].map((stage) => {
        const a = attribute({ ...opts, stage, useEventDate: false });
        const b = attribute({ ...opts, stage, useEventDate: true });
        let ca = 0, cb = 0, va = 0, vb = 0;
        eventChan.forEach((c) => {
          ca += a.channels[c].credit; cb += b.channels[c].credit;
          va += a.channels[c].value; vb += b.channels[c].value;
        });
        return { stage, creditLogged: ca, creditEventDate: cb, valueLogged: va, valueEventDate: vb };
      });
      return { eventTouches, late, lateShare: eventTouches ? late / eventTouches : 0, avgLagDays: late ? lagSum / late : 0, crossed, impact };
    });
  }

  // ----------------------------------------------------------------------
  // Postsale & PLG summaries
  // ----------------------------------------------------------------------
  function plg(period = [0, END]) {
    return memo("plg|" + period, () => {
      const plgC = contacts.filter((c) => c.path === "plg" && inPeriod(c.created, period));
      const act = plgC.filter((c) => c.activated != null);
      const pqlA = act.filter((c) => c.pql != null).length;
      const notAct = plgC.filter((c) => c.activated == null);
      const pqlN = notAct.filter((c) => c.pql != null).length;
      return {
        signups: plgC.length,
        activated: act.length,
        activationRate: plgC.length ? act.length / plgC.length : 0,
        pqlRateActivated: act.length ? pqlA / act.length : 0,
        pqlRateNotActivated: notAct.length ? pqlN / notAct.length : 0,
        pqlToSql: (() => {
          const p = plgC.filter((c) => c.pql != null);
          return p.length ? p.filter((c) => c.sql != null).length / p.length : 0;
        })(),
        mqlToSql: (() => {
          const m = contacts.filter((c) => c.mql != null && inPeriod(c.created, period));
          return m.length ? m.filter((c) => c.sql != null).length / m.length : 0;
        })(),
      };
    });
  }

  function postsale(period = [0, END]) {
    return memo("post|" + period, () => {
      const ren = deals.filter((d) => d.type === "renewal" && d.closed != null && inPeriod(d.closed, period));
      const adopted = (d) => contactsByAcct[acctIndex[d.account]].some((ci) => contacts[ci].activated != null && contacts[ci].activated <= d.closed);
      const rate = (arr) => (arr.length ? arr.filter((d) => d.status === "won").length / arr.length : null);
      const a = ren.filter(adopted), na = ren.filter((d) => !adopted(d));
      const base = ren.reduce((s, d) => s + (dealById[d.parent]?.amount || 0), 0);
      const kept = ren.filter((d) => d.status === "won").reduce((s, d) => s + (dealById[d.parent]?.amount || 0), 0);
      return { renewals: ren.length, renewalRate: rate(ren), adoptedRate: rate(a), notAdoptedRate: rate(na), adoptedN: a.length, notAdoptedN: na.length, grossRetention: base ? kept / base : null };
    });
  }

  // ----------------------------------------------------------------------
  // Rules-based optimization suggestions
  // ----------------------------------------------------------------------
  function suggestions(o) {
    const opts = { model: "w_shaped", lookbackDays: 365, period: [0, END], ...o };
    return memo("sugg|" + JSON.stringify(opts), () => {
      const out = [];
      const sc = scorecard();
      const chLabel = (i) => channels[i].label;
      const fmt$ = (v) => "$" + Math.round(v).toLocaleString("en-US");
      const pct = (v) => Math.round(v * 100) + "%";
      const stageLabel = (s) => STAGE[s].label;
      const topChannels = (a) => {
        const ai = assets.findIndex((x) => x.id === a.id);
        const counts = channels.map(() => 0);
        for (let i = 0; i < N; i++) if (tAsset[i] === ai) counts[tChan[i]]++;
        return counts.map((c, i) => [c, i]).filter((x) => x[0] > 0).sort((x, y) => y[0] - x[0]).map((x) => x[1]);
      };
      const customers = new Set(deals.filter((d) => d.type === "new_business" && d.status === "won").map((d) => d.account)).size;

      // 1. Amplify under-distributed winners
      for (const a of sc.filter((x) => x.status === "amplify").sort((x, y) => y.best.lift - x.best.lift)) {
        const via = topChannels(a).slice(0, 2).map(chLabel).join(" and ");
        const post = STAGE[a.best.stage].phase === "postsale";
        out.push({
          kind: "amplify", severity: "opportunity", asset: a.id,
          title: `Put ${a.name} in front of more ${post ? "customers" : "buyers"}`,
          detail: post
            ? `Customers who see it are ${a.best.lift.toFixed(1)}x as likely to ${a.best.stage === "renewal" ? "renew" : "buy " + (a.best.stage === "upsell" ? "an upsell" : "an expansion")} as comparable customers who don't, yet it has reached ${a.accounts} of ${customers} customer accounts, mostly through ${via}. Build it into onboarding, CSM playbooks and the QBR template.`
            : `Touches with this ${a.type.toLowerCase()} convert to ${stageLabel(a.best.stage)} at ${a.best.lift.toFixed(1)}x the rate of comparable touches, but it has reached only ${a.contacts} contacts (median asset: ${a.medianReach}), mostly through ${via}. Add it to nurture tracks and sales sequences for buyers approaching ${stageLabel(a.best.stage)}.`,
          metric: `${a.best.lift.toFixed(1)}x lift · ${post ? a.accounts + " accounts" : a.contacts + " contacts"} reached`,
        });
      }
      // 2. Double down
      const dd = sc.filter((x) => x.status === "double_down").sort((x, y) => y.best.lift - x.best.lift);
      if (dd.length) out.push({
        kind: "double_down", severity: "good",
        title: `Keep funding your ${dd.length} proven assets`,
        detail: dd.map((a) => `${a.name} (${a.best.lift.toFixed(1)}x at ${stageLabel(a.best.stage)})`).join("; ") + ". Commission refreshed editions, cut derivative formats from them, and protect their distribution budget before anything else.",
        metric: `${dd.length} assets`,
      });
      // 3. Stage mismatch
      for (const a of sc.filter((x) => x.mismatch && (x.status === "double_down" || x.status === "amplify"))) {
        out.push({
          kind: "reposition", severity: "opportunity", asset: a.id,
          title: `Reposition ${a.name} for ${stageLabel(a.mismatch)}`,
          detail: `It was built as ${stageLabel(a.intended_stage)} content, but its measurable effect is at ${stageLabel(a.mismatch)} (${a.best.lift.toFixed(1)}x). Give it to sales as late-stage enablement and stop judging it on ${stageLabel(a.intended_stage)} volume.`,
          metric: `${stageLabel(a.intended_stage)} → ${stageLabel(a.mismatch)}`,
        });
      }
      // 4. Fix
      const fixes = sc.filter((x) => x.status === "fix").sort((a, b) => b.contacts - a.contacts);
      if (fixes.length) {
        const lines = fixes.map((a) => {
          const peer = sc.find((x) => x.intended_stage === a.intended_stage && x.id !== a.id && (x.status === "double_down" || x.status === "amplify"))
            || sc.find((x) => STAGE[x.intended_stage].phase === STAGE[a.intended_stage].phase && x.id !== a.id && x.best && STAGE_ORDER[x.best.stage] === STAGE_ORDER[a.intended_stage]);
          return `${a.name} (${a.contacts} contacts${peer ? `; give its slots to ${peer.name}` : "; refresh the offer and call to action"})`;
        });
        out.push({
          kind: "fix", severity: "warning",
          title: `Fix or replace ${fixes.length} high-reach assets with no measurable effect`,
          detail: `These get wide distribution, but touches with them convert no better than comparable touches: ${lines.slice(0, 4).join("; ")}${lines.length > 4 ? `; and ${lines.length - 4} more in the scorecard` : ""}.`,
          metric: `${fixes.reduce((s2, a) => s2 + a.contacts, 0).toLocaleString("en-US")} contact exposures`,
          assets: fixes.map((a) => a.id),
        });
      }
      // 5. Kill
      const kill = sc.filter((x) => x.status === "kill");
      if (kill.length) {
        const cost = kill.reduce((s, a) => s + a.production_cost, 0);
        out.push({
          kind: "kill", severity: "critical",
          title: `Retire ${kill.length} assets that aren't moving buyers`,
          assets: kill.map((a) => a.id),
          detail: kill.map((a) => `${a.name}${a.worst ? ` (${a.worst.lift.toFixed(2)}x at ${stageLabel(a.worst.stage)})` : ""}`).join("; ") + `. Pull them from nurture and sales sequences so the slots go to proven assets. Production cost already spent on them: ${fmt$(cost)}.`,
          metric: `${fmt$(cost)} sunk cost`,
        });
      }
      // 6. Channel efficiency on SQLs
      const eff = efficiency(opts).filter((r) => r.cost > 0 && r.sql >= 3);
      const cps = eff.filter((r) => r.costPerSql).sort((a, b) => a.costPerSql - b.costPerSql);
      if (cps.length >= 3) {
        const med = cps[Math.floor(cps.length / 2)].costPerSql;
        const best = cps.find((r) => r.cost >= 100000) || cps[0];
        const worst = cps.filter((r) => r.costPerSql > 2 * med && r.cost > 50000);
        for (const r of worst) out.push({
          kind: "channel_cost", severity: "warning", channel: r.id,
          title: `${r.label} costs ${(r.costPerSql / med).toFixed(1)}x the median per SQL`,
          detail: `Under the ${MODELS.find((m) => m.id === opts.model).label} model, ${r.label} earns ${r.sql.toFixed(0)} SQLs on ${fmt$(r.cost)} of spend: ${fmt$(r.costPerSql)} per SQL against a ${fmt$(med)} median. Check whether it earns its keep at MQL or later stages before cutting it; otherwise shift budget toward ${best.label} (${fmt$(best.costPerSql)} per SQL).`,
          metric: `${fmt$(r.costPerSql)} per SQL`,
        });
        out.push({
          kind: "channel_best", severity: "good", channel: best.id,
          title: `${best.label} is your most efficient scaled SQL source`,
          detail: `${fmt$(best.costPerSql)} per SQL under ${MODELS.find((m) => m.id === opts.model).label} on ${fmt$(best.cost)} of spend, against a ${fmt$(med)} median across channels. Test a 20% budget increase and watch whether cost per SQL holds as it scales.`,
          metric: `${fmt$(best.costPerSql)} per SQL`,
        });
      }
      // 7. Feeder vs closer channels (model disagreement)
      const f = attribute({ ...opts, stage: "won", model: "first" });
      const l = attribute({ ...opts, stage: "won", model: "last" });
      const tot = f.conversions - f.unattributed || 1;
      channels.forEach((c, i) => {
        const fs = f.channels[i].credit / tot, ls = l.channels[i].credit / tot;
        if (fs >= 0.08 && fs >= 2.5 * ls) out.push({
          kind: "feeder", severity: "info", channel: c.id,
          title: `Judge ${c.label} on sourced pipeline, not last touch`,
          detail: `It opens ${pct(fs)} of won journeys but closes only ${pct(ls)}. A last-touch report would tell you to cut it; first-touch and W-shaped say it fills the funnel that other channels convert.`,
          metric: `${pct(fs)} first · ${pct(ls)} last`,
        });
        if (ls >= 0.08 && ls >= 2.5 * fs) out.push({
          kind: "closer", severity: "info", channel: c.id,
          title: `${c.label} closes deals it didn't source`,
          detail: `${pct(ls)} of won deals have it as the last touch, but it opens only ${pct(fs)} of journeys. It converts demand other channels create. Fund it in proportion to the pipeline that reaches it.`,
          metric: `${pct(ls)} last · ${pct(fs)} first`,
        });
      });
      // 8. PLG
      const p = plg(opts.period);
      if (p.signups > 20 && p.pqlRateActivated > 1.5 * p.pqlRateNotActivated) {
        const guide = sc.find((a) => a.type === "In-app guide");
        out.push({
          kind: "plg", severity: "opportunity",
          title: `Activation is the PQL lever: ${pct(p.pqlRateActivated)} vs ${pct(p.pqlRateNotActivated)}`,
          detail: `Activated free users become PQLs at ${(p.pqlRateActivated / Math.max(p.pqlRateNotActivated, 0.001)).toFixed(1)}x the rate of users who never activate, and ${pct(1 - p.activationRate)} of ${p.signups} signups never activate.${guide && guide.best ? ` ${guide.name} shows ${guide.best.lift.toFixed(1)}x lift at ${stageLabel(guide.best.stage)}; trigger it on day one for every signup.` : ""}`,
          metric: `${pct(p.activationRate)} activation`,
        });
      }
      // 10. Hygiene
      const h = hygiene(opts);
      if (h.late > 0) {
        const opp = h.impact.find((x) => x.stage === "opp");
        out.push({
          kind: "hygiene", severity: "warning",
          title: `${pct(h.lateShare)} of event touches were logged more than ${LATE_DAYS} days late`,
          detail: `Event lists are dated by record creation, so a scan uploaded ${h.avgLagDays.toFixed(0)} days after the event (average for late uploads) lands after conversions it caused. ${h.crossed} late touches landed after a stage change they likely influenced. Dated by event date, events would earn ${(opp.creditEventDate - opp.creditLogged).toFixed(1)} more opportunities of credit. Set a 72-hour upload SLA for event lists.`,
          metric: `${h.late} late touches`,
        });
      }
      const rank = { critical: 0, warning: 1, opportunity: 2, good: 3, info: 4 };
      return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
    });
  }

  const periods = {
    all: { id: "all", label: "All 24 months", range: [0, END] },
    fy25: { id: "fy25", label: "FY25 (Nov 2024 – Oct 2025)", range: [0, 365 * DAY] },
    fy26: { id: "fy26", label: "FY26 (Nov 2025 – Oct 2026)", range: [365 * DAY, END] },
  };

  return {
    meta, channels, assets, campaigns, accounts, contacts, deals, END, periods,
    touchCount: N,
    attribute, efficiency, lift, reach, scorecard, kpis, costs, paths, hygiene, plg, postsale, suggestions, markovEffects,
    dateOf: (h) => new Date(Date.parse(meta.epoch) + h * 3600e3),
  };
}
