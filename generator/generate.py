"""
Synthetic data generator for the Full-Funnel Attribution demo.

Creates 24 months of go-to-market history for Acme Corp, a fictional B2B SaaS
company that sells Acme Flow (workflow automation for operations teams) through
a hybrid motion: a marketing/sales-led path (MQL -> SQL -> Opportunity -> Won)
and a product-led path (signup -> activation -> PQL -> SQL -> ...), followed by
postsale motions (renewal, upsell, expansion).

The output mirrors what the HubSpot connector will produce: a normalized set of
accounts, contacts (with lifecycle timestamps), deals, campaigns, assets, costs
and touches. Offline and third-party touches (events, syndication, partner
referrals) are stamped with the CRM *record creation* time, which lags the real
interaction - exactly the way a list import behaves in a real portal.

Hidden "true" channel and asset effects drive conversions. They are written to
truth.json so the attribution engine can be validated against a known answer.

Usage:  python3 generator/generate.py [--seed 42] [--out docs/data]
Stdlib only.
"""
import argparse
import json
import math
import os
import random
from datetime import datetime, timedelta, timezone

EPOCH = datetime(2024, 11, 1, tzinfo=timezone.utc)
SIM_DAYS = 730  # Nov 1 2024 -> Oct 31 2026
H = 24.0       # hours per day; all timestamps are hours since EPOCH

# --------------------------------------------------------------------------
# Channels. effect = multiplier on the per-touch conversion probability for
# the stage a contact/account is working toward (truth, hidden from engine).
# --------------------------------------------------------------------------
CHANNELS = [
    # id, label, group, offline (logged at record creation)
    ("event_owned", "Events: owned & field", "Events", True),
    ("event_tradeshow", "Events: trade shows", "Events", True),
    ("webinar", "Webinars", "Content", False),
    ("syndication", "Trade publication syndication", "Paid media", True),
    ("paid_search", "Paid search", "Paid media", False),
    ("paid_social", "Paid social", "Paid media", False),
    ("organic_search", "Organic search & content", "Owned media", False),
    ("email_nurture", "Email: nurture", "Email", False),
    ("email_oneoff", "Email: one-off sends", "Email", False),
    ("email_customer", "Email: customer marketing", "Email", False),
    ("partner", "Partner referrals", "Partners", True),
    ("outbound_sdr", "Outbound SDR", "Sales", False),
    ("in_product", "In-product promotion", "Product", False),
]
CH = {c[0]: c for c in CHANNELS}

STAGES = ["mql", "pql", "sql", "opp", "won", "renewal", "upsell", "expansion"]

# Truth: channel effect by stage (1.0 = neutral)
CH_EFFECT = {
    "event_owned":     dict(mql=1.2, pql=1.0, sql=1.6, opp=1.8, won=1.35, renewal=1.3, upsell=1.2, expansion=1.4),
    "event_tradeshow": dict(mql=1.3, pql=1.0, sql=0.9, opp=0.8, won=1.0, renewal=1.0, upsell=1.0, expansion=1.0),
    "webinar":         dict(mql=1.3, pql=1.1, sql=1.7, opp=1.2, won=1.1, renewal=1.2, upsell=1.3, expansion=1.1),
    "syndication":     dict(mql=1.6, pql=1.0, sql=0.6, opp=0.7, won=1.0, renewal=1.0, upsell=1.0, expansion=1.0),
    "paid_search":     dict(mql=1.4, pql=1.3, sql=1.5, opp=1.1, won=1.0, renewal=1.0, upsell=1.0, expansion=1.0),
    "paid_social":     dict(mql=1.0, pql=0.9, sql=0.6, opp=0.7, won=1.0, renewal=1.0, upsell=1.0, expansion=1.0),
    "organic_search":  dict(mql=1.0, pql=1.2, sql=0.9, opp=0.9, won=1.0, renewal=1.0, upsell=1.0, expansion=1.0),
    "email_nurture":   dict(mql=1.1, pql=1.0, sql=1.1, opp=1.0, won=1.0, renewal=1.0, upsell=1.0, expansion=1.0),
    "email_oneoff":    dict(mql=0.8, pql=0.8, sql=0.7, opp=0.8, won=1.0, renewal=0.9, upsell=0.9, expansion=0.9),
    "email_customer":  dict(mql=1.0, pql=1.0, sql=1.0, opp=1.0, won=1.0, renewal=1.25, upsell=1.2, expansion=1.1),
    "partner":         dict(mql=1.3, pql=1.0, sql=1.6, opp=1.6, won=1.4, renewal=1.0, upsell=1.0, expansion=1.0),
    "outbound_sdr":    dict(mql=0.9, pql=1.4, sql=2.0, opp=1.3, won=1.0, renewal=1.0, upsell=1.0, expansion=1.0),
    "in_product":      dict(mql=1.0, pql=2.0, sql=1.2, opp=1.0, won=1.0, renewal=1.5, upsell=1.8, expansion=2.0),
}

# --------------------------------------------------------------------------
# Collateral / assets. eff = per-touch multiplier (truth). For 'won' and
# 'renewal' the value is an odds multiplier applied once per distinct asset.
# --------------------------------------------------------------------------
ASSETS = [
    # id, name, type, intended stage, production cost, channel weights, effects
    ("a01", "State of Ops Automation 2026", "Research report", "mql", 42000,
     dict(syndication=5, paid_social=3, organic_search=2, email_nurture=2, event_tradeshow=1),
     dict(mql=2.2, sql=1.3)),
    ("a02", "Ops Automation Buyer's Guide", "eBook", "mql", 18000,
     dict(syndication=6, paid_social=5, organic_search=3, email_nurture=3, paid_search=2),
     dict()),
    ("a03", "Acme ROI Calculator", "Interactive tool", "opp", 25000,
     dict(outbound_sdr=1.2, email_nurture=0.6, paid_search=0.4),
     dict(opp=3.0, won=3.0, sql=1.5)),
    ("a04", "Customer story: Cedarline Logistics", "Case study", "won", 9000,
     dict(outbound_sdr=3, email_nurture=2, organic_search=1, event_owned=1),
     dict(won=2.4, opp=1.4)),
    ("a05", "Customer story: Ironbridge Manufacturing", "Case study", "won", 9000,
     dict(outbound_sdr=0.8, email_nurture=0.6),
     dict()),
    ("a06", "Security & Compliance Overview", "One-pager", "won", 4000,
     dict(outbound_sdr=2, email_nurture=1),
     dict(won=1.5)),
    ("a07", "Acme Flow Product Tour", "Demo video", "pql", 15000,
     dict(organic_search=3, paid_search=3, in_product=2, email_nurture=2, paid_social=2),
     dict(pql=1.8, sql=1.5, mql=1.2)),
    ("a08", "Analyst Brief: Ops Automation Platforms", "Analyst report", "sql", 60000,
     dict(email_nurture=2, outbound_sdr=2, syndication=2, paid_search=1),
     dict(sql=1.25)),
    ("a09", "10 Workflow Templates", "Template pack", "pql", 7000,
     dict(organic_search=3, in_product=3, email_nurture=2, paid_social=1),
     dict(pql=2.4, mql=1.3)),
    ("a10", "Integration Catalog", "Product guide", "expansion", 6000,
     dict(email_customer=1.5, in_product=1.5, organic_search=1),
     dict(expansion=5.0, upsell=1.3)),
    ("a11", "Admin Best Practices Guide", "Guide", "renewal", 8000,
     dict(email_customer=1.2, in_product=0.8),
     dict(renewal=3.5)),
    ("a12", "Advanced Analytics Add-on", "One-pager", "upsell", 3500,
     dict(email_customer=1.2, outbound_sdr=1),
     dict(upsell=6.0)),
    ("a13", "Webinar: Automating Month-End Close", "Webinar recording", "mql", 6000,
     dict(webinar=4, email_nurture=2, organic_search=1),
     dict(mql=1.5, sql=1.2)),
    ("a14", "Webinar: AI Agents for Operations", "Webinar recording", "sql", 6000,
     dict(webinar=4, email_nurture=2, paid_social=1),
     dict(sql=2.2, opp=1.4)),
    ("a15", "Blog: What Is Workflow Automation?", "Blog post", "mql", 1500,
     dict(organic_search=9, paid_social=1),
     dict(mql=1.05)),
    ("a16", "Acme vs. Legacy BPM Suites", "Comparison guide", "mql", 5000,
     dict(paid_search=3, organic_search=2, outbound_sdr=1),
     dict(opp=2.4, won=1.6)),
    ("a17", "Infographic: The Hidden Cost of Manual Ops", "Infographic", "mql", 3000,
     dict(paid_social=1.2, organic_search=0.4),
     dict(mql=0.9)),
    ("a18", "Implementation Playbook", "Playbook", "won", 12000,
     dict(outbound_sdr=1.5, email_customer=2, email_nurture=0.8),
     dict(won=1.7, renewal=2.0)),
    ("a19", "Executive Briefing Deck", "Sales deck", "opp", 10000,
     dict(outbound_sdr=3, event_owned=2),
     dict(won=0.7, opp=0.9)),
    ("a20", "Ops in Healthcare: 2026 Benchmark", "Industry report", "mql", 14000,
     dict(syndication=0.25, email_nurture=0.15),
     dict(mql=1.4)),
    ("a21", "In-app guide: Build Your First Automation", "In-app guide", "pql", 4000,
     dict(in_product=6),
     dict(pql=2.8, sql=1.2)),
    ("a22", "In-app promo: Analytics Add-on Trial", "In-app promo", "upsell", 2500,
     dict(in_product=1.5),
     dict(upsell=8.0)),
    ("a23", "In-app promo: Invite Your Team", "In-app promo", "expansion", 2000,
     dict(in_product=1.5),
     dict(expansion=7.0)),
    ("a24", "Customer Newsletter", "Newsletter", "renewal", 1500,
     dict(email_customer=5),
     dict(renewal=1.1)),
]
ASSET = {a[0]: a for a in ASSETS}

# Channels that can carry an asset; others are bare touches (eg an ad click to a
# landing page, an event scan).
ASSET_RATE = dict(syndication=1.0, paid_social=0.7, organic_search=0.75, email_nurture=0.8,
                  email_oneoff=0.3, email_customer=0.85, paid_search=0.45, webinar=0.9,
                  outbound_sdr=0.55, in_product=0.85, event_owned=0.2, event_tradeshow=0.1,
                  partner=0.0)

TOUCH_KIND = dict(event_owned="event_attended", event_tradeshow="booth_scan", webinar="webinar_attended",
                  syndication="syndication_lead", paid_search="ad_click", paid_social="ad_click",
                  organic_search="page_view", email_nurture="email_click", email_oneoff="email_click",
                  email_customer="email_click", partner="partner_referral", outbound_sdr="sales_touch",
                  in_product="in_app_engagement")

TIERS = [  # name, share, acv range, fit multiplier, contacts range
    ("SMB", 0.45, (12000, 30000), 1.15, (1, 2)),
    ("Mid-market", 0.38, (30000, 90000), 1.0, (2, 4)),
    ("Enterprise", 0.17, (90000, 260000), 0.8, (3, 6)),
]
INDUSTRIES = ["Logistics", "Manufacturing", "Healthcare", "Financial services", "Retail",
              "Energy", "Insurance", "Food & beverage", "Construction", "Media"]
NAME_A = ["Cedar", "Iron", "Blue", "North", "Granite", "Lumen", "Copper", "Crest", "Pine", "Quarry",
          "Silt", "Brook", "Alder", "Basalt", "Fern", "Marlow", "Tidal", "Upland", "Vale", "Wren",
          "Kestrel", "Juniper", "Harrow", "Oxbow", "Ridge", "Saltmarsh", "Thistle", "Larch", "Mesa", "Corbel"]
NAME_B = ["line", "bridge", "field", "gate", "stone", "worth", "ford", "hollow", "point", "haven"]
CITIES = ["Chicago", "Austin", "Atlanta", "Denver", "Boston", "Seattle", "Dallas", "New York",
          "San Francisco", "Minneapolis", "Charlotte", "Phoenix"]

ACQ_MIX = dict(organic_search=0.17, paid_search=0.11, paid_social=0.10, syndication=0.17,
               event_tradeshow=0.08, event_owned=0.04, webinar=0.09, partner=0.05,
               outbound_sdr=0.12, email_oneoff=0.02, in_product=0.0, email_nurture=0.0)
PRE_MIX = dict(email_nurture=0.24, organic_search=0.13, paid_social=0.08, paid_search=0.07,
               webinar=0.09, syndication=0.05, event_owned=0.04, event_tradeshow=0.04,
               outbound_sdr=0.12, email_oneoff=0.06, partner=0.02, in_product=0.0)
PLG_EXTRA = dict(in_product=0.35)
OPP_MIX = dict(outbound_sdr=0.35, email_nurture=0.18, event_owned=0.10, webinar=0.08,
               organic_search=0.08, paid_search=0.05, email_oneoff=0.04, partner=0.04,
               event_tradeshow=0.03, paid_social=0.03, in_product=0.0)
CUST_MIX = dict(email_customer=0.40, in_product=0.30, webinar=0.10, event_owned=0.08,
                organic_search=0.06, outbound_sdr=0.06)

BASE = dict(mql=0.045, pql=0.060, sql=0.050, opp=0.06, upsell=0.0020, expansion=0.0018)


def wchoice(rng, weights):
    items = [(k, v) for k, v in weights.items() if v > 0]
    total = sum(v for _, v in items)
    r = rng.random() * total
    for k, v in items:
        r -= v
        if r <= 0:
            return k
    return items[-1][0]


class World:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.accounts, self.contacts, self.deals = [], [], []
        self.touches = []  # dicts
        self.campaigns = []
        self.events = {"event_owned": [], "event_tradeshow": [], "webinar": []}
        self.late_truth = 0
        self._build_campaigns()

    # ------------------------------------------------------------------
    def _build_campaigns(self):
        rng = self.rng
        cid = 0

        def add(name, channel, day, cost, kind):
            nonlocal cid
            cid += 1
            c = dict(id=f"c{cid:03d}", name=name, channel=channel, date=round(day * H, 1),
                     cost=cost, type=kind)
            self.campaigns.append(c)
            return c

        d = 8
        while d < SIM_DAYS - 5:  # owned field events ~ every 2-3 weeks
            city = rng.choice(CITIES)
            fmt = rng.choice(["Executive dinner", "Ops roadshow", "Customer roundtable"])
            c = add(f"{fmt}: {city}", "event_owned", d, rng.choice([14000, 18000, 22000]), "event")
            self.events["event_owned"].append(c)
            d += rng.randint(14, 24)
        for yr, day in ((2025, 200), (2026, 565)):  # annual user conference
            c = add(f"Acme Connect {yr} (user conference)", "event_owned", day, 240000, "event")
            self.events["event_owned"].append(c)
        shows = ["OpsWorld Expo", "Automation Leaders Summit", "Enterprise Workflow Forum",
                 "Supply Chain Tech Week", "FinOps & Ops Conference"]
        for yr_off, yr in ((0, 2025), (365, 2026)):
            for i, s in enumerate(shows):
                day = yr_off + 30 + i * 68 + rng.randint(-8, 8)
                if day < SIM_DAYS - 5:
                    c = add(f"{s} {yr}", "event_tradeshow", day, rng.choice([65000, 85000, 110000]), "event")
                    self.events["event_tradeshow"].append(c)
        d = 5
        topics = ["Automating Month-End Close", "AI Agents for Operations", "Workflow Governance 101",
                  "From Spreadsheets to Systems", "Ops Metrics That Matter", "Scaling Approvals"]
        while d < SIM_DAYS - 3:
            c = add(f"Webinar: {rng.choice(topics)}", "webinar", d, 6000, "webinar")
            self.events["webinar"].append(c)
            d += rng.randint(12, 18)
        pubs = ["Enterprise Ops Review", "CIO Signal", "Workflow Weekly"]
        for q in range(8):
            for p in pubs:
                add(f"{p} syndication Q{q % 4 + 1} FY{25 + q // 4}", "syndication", q * 91.25, 0, "program")
        for ch, nm in (("paid_search", "Paid search: always-on"), ("paid_social", "Paid social: always-on"),
                       ("organic_search", "SEO & content program"), ("email_nurture", "Nurture program"),
                       ("email_oneoff", "Newsletter & promo sends"), ("email_customer", "Customer marketing program"),
                       ("partner", "Partner program"), ("outbound_sdr", "SDR program"),
                       ("in_product", "In-product messaging")):
            add(nm, ch, 0, 0, "program")
        self.camp_by_ch = {}
        for c in self.campaigns:
            self.camp_by_ch.setdefault(c["channel"], []).append(c)

    # ------------------------------------------------------------------
    def pick_campaign(self, ch, day):
        """Return (campaign, actual_day) for a touch drawn at sim day `day`."""
        if ch in self.events:
            nxt = [c for c in self.events[ch] if c["date"] / H >= day - 1]
            if not nxt or nxt[0]["date"] / H - day > 40:
                return None, None
            if ch == "event_owned" and "Acme Connect" in nxt[0]["name"]:
                pass
            return nxt[0], nxt[0]["date"] / H + self.rng.random() * 0.4
        if ch == "syndication":
            q = min(int(day // 91.25), 7)
            pubs = [c for c in self.camp_by_ch["syndication"] if c["date"] / H == q * 91.25]
            return self.rng.choice(pubs), day
        return self.camp_by_ch[ch][0], day

    def logged_day(self, ch, actual):
        rng = self.rng
        if ch in ("event_owned", "event_tradeshow"):
            lag = rng.uniform(0.5, 4) if rng.random() < 0.7 else rng.uniform(7, 26)
        elif ch == "syndication":
            lag = rng.uniform(2, 9)  # weekly batch delivery
        elif ch == "partner":
            lag = rng.uniform(1, 10)
        else:
            lag = 0
        return actual + lag

    def pick_asset(self, ch, stage_hint):
        rng = self.rng
        if rng.random() > ASSET_RATE.get(ch, 0):
            return None
        cands = {}
        for a in ASSETS:
            w = a[5].get(ch, 0)
            if not w:
                continue
            # customer channels favour postsale assets; prospect channels avoid them
            post = a[3] in ("renewal", "upsell", "expansion")
            if stage_hint == "customer":
                w *= 3.0 if post else 0.15
            elif post:
                w *= 0.05
            cands[a[0]] = w
        if not cands:
            return None
        return wchoice(rng, cands)

    def add_touch(self, contact, ch, actual_day, stage_hint, created_override=None):
        camp, actual = self.pick_campaign(ch, actual_day)
        if camp is None:
            return None
        if actual > SIM_DAYS:
            return None
        logged = self.logged_day(ch, actual) if CH[ch][3] else actual
        if created_override is not None:
            logged = max(logged, created_override)
        asset = self.pick_asset(ch, stage_hint)
        t = dict(contact=contact["id"], t=round(logged * H, 1), actual=actual, ch=ch, asset=asset,
                 campaign=camp["id"], kind=TOUCH_KIND[ch])
        if logged > SIM_DAYS:
            return None
        self.touches.append(t)
        return t

    # ------------------------------------------------------------------
    def eff(self, touch, stage):
        e = CH_EFFECT[touch["ch"]].get(stage, 1.0)
        if touch["asset"]:
            e *= ASSET[touch["asset"]][6].get(stage, 1.0)
        return e

    def run(self, n_accounts=950):
        rng = self.rng
        used = set()
        for i in range(n_accounts):
            tier = wchoice(rng, {t[0]: t[1] for t in TIERS})
            tdef = next(t for t in TIERS if t[0] == tier)
            while True:
                nm = rng.choice(NAME_A) + rng.choice(NAME_B)
                ind = rng.choice(INDUSTRIES)
                full = f"{nm} {ind.split()[0] if ind != 'Food & beverage' else 'Foods'}"
                if full not in used:
                    used.add(full)
                    break
            acct = dict(id=f"co{i + 1:04d}", name=full, tier=tier, industry=ind,
                        fit=tdef[3] * rng.uniform(0.6, 1.4))
            self.accounts.append(acct)
            self.simulate_account(acct, tdef)
        self.simulate_installed_base(int(n_accounts * 0.32))
        self.touches.sort(key=lambda x: x["t"])

    def simulate_installed_base(self, n):
        """Customers who closed in the 12 months before the data window starts.
        Their presale history predates the window; their postsale life is inside it."""
        rng = self.rng
        for i in range(n):
            tier = wchoice(rng, {t[0]: t[1] for t in TIERS})
            tdef = next(t for t in TIERS if t[0] == tier)
            nm = rng.choice(NAME_A) + rng.choice(NAME_B) + " " + rng.choice(["Group", "Holdings", "Partners", "Co."])
            acct = dict(id=f"co{len(self.accounts) + 1:04d}", name=nm, tier=tier, industry=rng.choice(INDUSTRIES),
                        fit=tdef[3] * rng.uniform(0.6, 1.4))
            self.accounts.append(acct)
            close_day = -rng.uniform(5, 360)
            contacts = []
            for k in range(rng.randint(*tdef[4])):
                c = dict(id=f"ct{len(self.contacts) + 1:05d}", account=acct["id"],
                         created=round((close_day - rng.uniform(30, 200)) * H, 1), path="mkt",
                         signup=None, activated=None, mql=None, pql=None, sql=None, _touches=[])
                if rng.random() < 0.4:
                    c["activated"] = round((close_day + rng.uniform(5, 60)) * H, 1)
                self.contacts.append(c)
                contacts.append(c)
            acv = round(rng.uniform(*tdef[2]), -2)
            deal = dict(id=f"d{len(self.deals) + 1:04d}", account=acct["id"], type="new_business",
                        created=round((close_day - rng.uniform(30, 90)) * H, 1), closed=round(close_day * H, 1),
                        status="won", amount=acv, source="installed_base")
            self.deals.append(deal)
            self.simulate_customer(acct, contacts, deal, close_day, acv)

    def simulate_account(self, acct, tdef):
        rng = self.rng
        first_day = rng.uniform(0, SIM_DAYS - 45)
        n = rng.randint(*tdef[4])
        acct_contacts = []
        for k in range(n):
            start = first_day + (0 if k == 0 else rng.uniform(0, 140))
            if start > SIM_DAYS - 10:
                continue
            c = self.simulate_contact(acct, start)
            if c:
                acct_contacts.append(c)
        if not acct_contacts:
            return
        self.simulate_opportunity(acct, tdef, acct_contacts)

    def simulate_contact(self, acct, start):
        rng = self.rng
        cid = f"ct{len(self.contacts) + 1:05d}"
        ch = wchoice(rng, ACQ_MIX)
        plg = rng.random() < (0.38 if ch in ("organic_search", "paid_search", "paid_social") else 0.06)
        contact = dict(id=cid, account=acct["id"], created=None, path="plg" if plg else "mkt",
                       signup=None, activated=None, mql=None, pql=None, sql=None, _touches=[])
        first = self.add_touch(contact, ch, start, "prospect")
        if first is None:
            return None
        contact["created"] = first["t"]
        first["first"] = True
        contact["_touches"].append(first)
        day = first["t"] / H
        if plg:
            contact["signup"] = round((day + rng.uniform(0, 0.2)) * H, 1)
        self.contacts.append(contact)
        stage = "pql" if plg else "mql"
        dormancy = 0.045
        while True:
            gap = rng.expovariate(1 / (5.5 if plg else 8.0))
            day += gap
            if day > SIM_DAYS or rng.random() < dormancy:
                break
            if contact["sql"] is not None:
                break  # account-level simulation takes over after SQL
            mix = dict(PRE_MIX)
            if plg:
                for kk, vv in PLG_EXTRA.items():
                    mix[kk] = mix.get(kk, 0) + vv
            tch = wchoice(rng, mix)
            t = self.add_touch(contact, tch, day, "prospect", created_override=contact["created"] / H)
            if t is None:
                continue
            contact["_touches"].append(t)
            act_day = t["actual"]
            # product activation (PLG): in-product touches drive activation
            if plg and contact["activated"] is None and tch == "in_product":
                if rng.random() < 0.18 * self.eff(t, "pql"):
                    contact["activated"] = round(act_day * H + rng.uniform(1, 30), 1)
            p = BASE[stage] * self.eff(t, stage) * acct["fit"]
            if stage == "pql" and contact["activated"] is not None:
                p *= 1.6
            if rng.random() < min(p, 0.85):
                conv = round((act_day + rng.uniform(0.05, 3)) * H, 1)
                if conv / H > SIM_DAYS:
                    break
                if stage in ("mql", "pql"):
                    contact[stage] = conv
                    stage = "sql"
                    dormancy = 0.05
                else:
                    contact["sql"] = conv
            # recorded touches that land after a conversion they actually preceded
        return contact

    def contact_touch_loop(self, contacts, start_day, end_day, mix, stage_hint, cb):
        """Generate touches across contacts between days; cb(touch) -> stop?"""
        rng = self.rng
        day = start_day
        mean_gap = (13.0 if stage_hint == "customer" else 6.0) * rng.uniform(0.6, 1.6)
        while day < min(end_day, SIM_DAYS):
            day += rng.expovariate(1 / (mean_gap / max(1, len(contacts)) ** 0.5))
            if day >= min(end_day, SIM_DAYS):
                break
            if day < 0:
                continue
            c = rng.choice(contacts)
            t = self.add_touch(c, wchoice(rng, mix), day, stage_hint, created_override=c["created"] / H)
            if t is None:
                continue
            if cb(t):
                return t
        return None

    def simulate_opportunity(self, acct, tdef, contacts):
        rng = self.rng
        sqls = [c for c in contacts if c["sql"] is not None]
        if not sqls:
            return
        sql_day = min(c["sql"] for c in sqls) / H
        opp_holder = {}
        if rng.random() < 0.12 * acct["fit"]:
            opp_holder["day"] = sql_day + rng.uniform(1, 10)
        else:
            def cb(t):
                if rng.random() < min(BASE["opp"] * self.eff(t, "opp") * acct["fit"], 0.8):
                    opp_holder["day"] = t["actual"] + rng.uniform(0.5, 5)
                    return True
                return False
            self.contact_touch_loop(contacts, sql_day, sql_day + 100, OPP_MIX, "prospect", cb)
        if "day" not in opp_holder or opp_holder["day"] > SIM_DAYS:
            return
        opp_day = opp_holder["day"]
        acv = round(rng.uniform(*tdef[2]), -2)
        cycle = rng.uniform(25, 75) * (1.6 if tdef[0] == "Enterprise" else 1.0)
        close_day = opp_day + cycle
        deal = dict(id=f"d{len(self.deals) + 1:04d}", account=acct["id"], type="new_business",
                    created=round(opp_day * H, 1), closed=None, status="open", amount=acv)
        self.deals.append(deal)
        cycle_touches = []
        self.contact_touch_loop(contacts, opp_day, close_day, OPP_MIX, "prospect",
                                lambda t: cycle_touches.append(t) and False)
        # win probability: odds multipliers from distinct assets/channels during the cycle
        logit = -2.25 + (0.25 if tdef[0] == "SMB" else 0) + math.log(acct["fit"])
        for a in {t["asset"] for t in cycle_touches if t["asset"]}:
            logit += math.log(ASSET[a][6].get("won", 1.0))
        for ch in {t["ch"] for t in cycle_touches}:
            logit += 0.6 * math.log(CH_EFFECT[ch]["won"])
        logit += min(len(cycle_touches), 12) * 0.03
        pwin = 1 / (1 + math.exp(-logit))
        if close_day > SIM_DAYS:
            return  # still open
        deal["closed"] = round(close_day * H, 1)
        if rng.random() < pwin:
            deal["status"] = "won"
            self.simulate_customer(acct, contacts, deal, close_day, acv)
        else:
            deal["status"] = "lost"

    def simulate_customer(self, acct, contacts, deal, start_day, acv):
        rng = self.rng
        term_end = start_day + 365
        events = {"upsell": [], "expansion": []}
        adopted = any(c["activated"] for c in contacts) or rng.random() < 0.45
        term_touches = []
        mult = {"upsell": 1.0, "expansion": 1.0}

        def cb(t):
            term_touches.append(t)
            for kind in ("upsell", "expansion"):
                p = BASE[kind] * self.eff(t, kind) * mult[kind] * (1.3 if adopted else 0.8)
                if rng.random() < min(p, 0.5):
                    d = t["actual"] + rng.uniform(5, 30)
                    if d < SIM_DAYS:
                        amt = round(acv * (rng.uniform(0.12, 0.3) if kind == "upsell" else rng.uniform(0.2, 0.6)), -2)
                        self.deals.append(dict(id=f"d{len(self.deals) + 1:04d}", account=acct["id"], type=kind,
                                               created=round(t["actual"] * H, 1), closed=round(d * H, 1),
                                               status="won", amount=amt, parent=deal["id"]))
                        events[kind].append(amt)
                        mult[kind] *= 0.35
            return False

        self.contact_touch_loop(contacts, start_day, min(term_end, SIM_DAYS), CUST_MIX, "customer", cb)
        if term_end <= SIM_DAYS:
            logit = -0.9 + (0.6 if adopted else -0.6)
            for a in {t["asset"] for t in term_touches if t["asset"]}:
                logit += math.log(ASSET[a][6].get("renewal", 1.0))
            for ch in {t["ch"] for t in term_touches}:
                logit += 0.6 * math.log(CH_EFFECT[ch]["renewal"])
            p = 1 / (1 + math.exp(-logit))
            amount = acv + sum(events["upsell"]) + sum(events["expansion"])
            won = rng.random() < p
            self.deals.append(dict(id=f"d{len(self.deals) + 1:04d}", account=acct["id"], type="renewal",
                                   created=round((term_end - 90) * H, 1), closed=round(term_end * H, 1),
                                   status="won" if won else "lost", amount=round(amount, -2), parent=deal["id"]))

    # ------------------------------------------------------------------
    def costs(self):
        """Monthly cost rows by channel (program budgets + campaign costs)."""
        monthly = dict(paid_search=32000, paid_social=21000, organic_search=16000, email_nurture=3500,
                       email_oneoff=1500, email_customer=3000, partner=7000, outbound_sdr=58000,
                       in_product=4500, syndication=0, webinar=0, event_owned=0, event_tradeshow=0)
        rows = {}
        for m in range(24):
            for ch, amt in monthly.items():
                if amt:
                    rows[(m, ch)] = rows.get((m, ch), 0) + amt
        for c in self.campaigns:
            if c["cost"]:
                m = min(int(c["date"] / H // 30.42), 23)
                rows[(m, c["channel"])] = rows.get((m, c["channel"]), 0) + c["cost"]
        # syndication is billed per lead delivered (CPL)
        for t in self.touches:
            if t["ch"] == "syndication":
                m = min(int(t["t"] / H // 30.42), 23)
                rows[(m, "syndication")] = rows.get((m, "syndication"), 0) + 115
        return [dict(month=m, channel=ch, cost=round(v)) for (m, ch), v in sorted(rows.items())]


def month_label(m):
    d = EPOCH + timedelta(days=m * 30.42 + 2)
    return d.strftime("%Y-%m")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--accounts", type=int, default=1150)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "docs", "data"))
    args = ap.parse_args()
    w = World(args.seed)
    w.run(args.accounts)

    # late-logged ground truth: recorded after a stage it actually preceded
    ch_idx = {c[0]: i for i, c in enumerate(CHANNELS)}
    asset_ids = [a[0] for a in ASSETS]
    a_idx = {a: i for i, a in enumerate(asset_ids)}
    camp_idx = {c["id"]: i for i, c in enumerate(w.campaigns)}
    contact_idx = {c["id"]: i for i, c in enumerate(w.contacts)}

    data = dict(
        schema="ffa/1",
        meta=dict(company="Acme Corp", product="Acme Flow",
                  description="Synthetic demo data. Acme Corp is fictional.",
                  epoch=EPOCH.isoformat(), days=SIM_DAYS, time_unit="hours since epoch",
                  generated_with=f"generator/generate.py --seed {args.seed}",
                  months=[month_label(m) for m in range(24)]),
        channels=[dict(id=c[0], label=c[1], group=c[2], offline=c[3]) for c in CHANNELS],
        assets=[dict(id=a[0], name=a[1], type=a[2], intended_stage=a[3], production_cost=a[4]) for a in ASSETS],
        campaigns=[{k: v for k, v in c.items()} for c in w.campaigns],
        accounts=[dict(id=a["id"], name=a["name"], tier=a["tier"], industry=a["industry"]) for a in w.accounts],
        contacts=[{k: c[k] for k in ("id", "account", "created", "path", "signup", "activated", "mql", "pql", "sql")}
                  for c in w.contacts],
        deals=[{k: d.get(k) for k in ("id", "account", "type", "created", "closed", "status", "amount", "parent", "source")}
               for d in w.deals],
        costs=w.costs(),
        touches=dict(
            columns=["contact", "t", "channel", "asset", "campaign"],
            contact=[contact_idx[t["contact"]] for t in w.touches],
            t=[t["t"] for t in w.touches],
            channel=[ch_idx[t["ch"]] for t in w.touches],
            asset=[a_idx[t["asset"]] if t["asset"] else -1 for t in w.touches],
            campaign=[camp_idx[t["campaign"]] for t in w.touches],
        ),
    )
    truth = dict(channel_effects=CH_EFFECT, asset_effects={a[0]: a[6] for a in ASSETS},
                 note="Hidden effects used by the generator. The engine never reads this file; tests do.")
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "acme.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"))
    tdir = os.path.join(os.path.dirname(__file__), "..", "tests")
    os.makedirs(tdir, exist_ok=True)
    with open(os.path.join(tdir, "truth.json"), "w") as f:
        json.dump(truth, f, indent=1)

    # summary
    cs = w.contacts
    deals = w.deals
    nb = [d for d in deals if d["type"] == "new_business"]
    print(f"accounts {len(w.accounts)}  contacts {len(cs)}  touches {len(w.touches)}")
    print(f"MQL {sum(1 for c in cs if c['mql'])}  PQL {sum(1 for c in cs if c['pql'])}  "
          f"activated {sum(1 for c in cs if c['activated'])}  SQL {sum(1 for c in cs if c['sql'])}")
    print(f"opps {len(nb)}  won {sum(1 for d in nb if d['status'] == 'won')}  "
          f"lost {sum(1 for d in nb if d['status'] == 'lost')}  open {sum(1 for d in nb if d['status'] == 'open')}")
    for k in ("renewal", "upsell", "expansion"):
        ds = [d for d in deals if d["type"] == k]
        print(f"{k}: {len(ds)} (won {sum(1 for d in ds if d['status'] == 'won')})  "
              f"${sum(d['amount'] for d in ds if d['status'] == 'won'):,.0f}")
    print(f"new-biz won ${sum(d['amount'] for d in nb if d['status'] == 'won'):,.0f}")
    print(f"file {os.path.getsize(os.path.join(args.out, 'acme.json')) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
