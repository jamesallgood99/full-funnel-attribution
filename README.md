# Full-Funnel Attribution

Multi-touch attribution for B2B marketing teams that need to know which channels and which pieces of collateral are working, from first touch through renewal, upsell and expansion. It's built to plug into HubSpot, and it ships with a live demo running on synthetic data for a fictional company, Acme Corp.

**Live demo:** https://jamesallgood99.github.io/full-funnel-attribution/

## What it answers

- **Which channels create pipeline and revenue, and at what cost?** Seven attribution models run side by side: first touch, last touch, linear, time decay, U-shaped, W-shaped and a data-driven Markov model. They cover MQL, PQL, SQL, Opportunity, Closed-won, Renewal, Upsell and Expansion.
- **Which collateral actually moves buyers?** Credit only shows where an asset appeared. Lift shows whether it changed anything. Every asset gets a verdict: *Double down*, *Amplify*, *Fix or replace*, *Kill*, or *Not enough data*.
- **What should we change?** The Optimization tab turns the numbers into ranked recommendations and builds an editable PowerPoint readout for leadership in one click.

## Design decisions

| Decision | Why |
|---|---|
| **Two front doors: MQL and PQL** | Product-led growth is part of the model. Signup, activation and product-qualified signals sit alongside the marketing path, and in-product promotion is a channel. |
| **Postsale attribution** | Renewal, upsell and expansion each get their own attribution. Only touches after the customer's original close count, so presale campaigns can't claim retention revenue and customer marketing gets measured on the revenue it keeps and grows. |
| **Account-level credit for deals** | Opportunity and Closed-won credit uses touches from every contact at the account, not only the contact on the deal. B2B buying groups work that way. |
| **Offline touches use record creation time** | Events, trade publication syndication and partner referrals take the HubSpot record creation timestamp. That's the reliable timestamp in most portals. The tool then measures what late list uploads cost and shows a what-if against the event date. |
| **Lift is model-independent** | Asset verdicts come from regression, not from the attribution model you happen to have selected. Switching models changes channel credit, not whether an asset works. |

## How collateral lift works

An asset that appears in every journey collects credit under every model, whether or not it does anything. Lift holds the channel and the buyer's engagement constant and asks one question: is a touch with this asset followed by the next stage more often than a comparable touch without it?

- **MQL, PQL, SQL, Opportunity:** a touch-level, L2-regularized logistic regression. The outcome is reaching the stage within 7–14 days of the touch. Controls are the channel and how deep into the journey the touch falls.
- **Closed-won and renewal:** a deal-level regression, comparing deals exposed to the asset with comparable deals that weren't. Controls are touch volume and the channels present.
- **Upsell and expansion:** customer-level, with exposure measured as dose (how many times the account engaged with the asset).
- Results are corrected for running roughly 190 tests at once (Benjamini-Hochberg, 10% false discovery rate). Each asset is judged on the phase it was built for, presale or postsale.

**Verdict rules:** *Double down* means significant lift of at least 1.2x and reach at or above the median asset. *Amplify* is the same lift with below-median reach. *Fix or replace* means wide reach with no detectable effect. *Kill* means negative lift, or no effect and little reach.

## Validation

The generator plants known effects. For example, the ROI calculator triples the odds of winning, and the buyer's guide does nothing. `tests/engine.test.mjs` checks two things:

1. Every model conserves credit: credit always sums to the number of attributed conversions, for all 7 models × 8 stages.
2. Every significant lift points the same direction as the planted effect, and most strong planted effects are detected.

Across six random seeds, the engine consistently finds the planted winners (the research report, ROI calculator, in-app onboarding guide and admin guide) and the planted duds (the buyer's guide, Ironbridge case study and infographic). It produces 0–2 false positives per seed. Small postsale samples are the main limit on detection, as they are in real portals.

## The demo data

`generator/generate.py` (standard library only, seeded) simulates 24 months of Acme Corp, a fictional company selling *Acme Flow*, workflow automation for operations teams:

- About 1,500 accounts and 3,700 contacts, including an installed base of customers who closed before the window, and about 60,000 touches across 13 channels
- 24 collateral assets with hidden per-stage effects
- Owned events, trade shows, webinars and quarterly syndication programs, with real-world costs, cost-per-lead billing and late list uploads
- New-business, renewal, upsell and expansion deals

Every company, person, event and publication in the data is fictional.

## Run it locally

```bash
python3 generator/generate.py      # writes docs/data/acme.json and tests/truth.json
node tests/engine.test.mjs         # model and lift validation
python3 -m http.server 8000 -d docs   # open http://localhost:8000
```

There are no build steps. The front end is plain ES modules. PptxGenJS 3.12.0 is vendored in `docs/vendor/` for the deck export.

## Project layout

```
generator/generate.py   synthetic Acme Corp dataset (schema ffa/1)
docs/                   the GitHub Pages site
  js/engine.js          attribution models, Markov, lift regression, verdicts, recommendations
  js/app.js             dashboard views
  js/charts.js          dependency-free bar, heatmap and quadrant charts
  js/deck.js            leadership deck (.pptx) builder
  data/acme.json        generated demo data
tests/                  engine tests and the generator's answer key
```

## Data model (schema `ffa/1`)

The engine reads one normalized dataset. The demo generator and the HubSpot connector both produce it:

- `accounts`: id, name, tier, industry
- `contacts`: id, account, created, path (`mkt` or `plg`), signup, activated, mql, pql, sql timestamps
- `deals`: id, account, type (`new_business`, `renewal`, `upsell`, `expansion`), created, closed, status, amount, parent
- `campaigns`: id, name, channel, date, cost
- `assets`: id, name, type, intended stage, production cost
- `costs`: monthly program spend by channel
- `touches`: columnar arrays of contact, timestamp, channel, asset and campaign

## HubSpot connector (next)

| Engine field | HubSpot source |
|---|---|
| Contact lifecycle dates | `hs_lifecyclestage_marketingqualifiedlead_date`, `..._salesqualifiedlead_date`, and similar |
| PQL, signup, activation | Product-usage properties or custom behavioral events |
| Deals | Deals associated with companies; `dealtype` maps to new business, renewal, upsell or expansion |
| Touches | Form submissions, marketing email clicks, page views, ad interactions, campaign membership, sales activities, custom events |
| Offline touches | List-import or campaign-membership records, timestamped at record creation |
| Assets | File, landing-page and campaign asset IDs mapped through an asset registry |
| Costs | Campaign budget fields plus a monthly program-spend CSV |

The connector will be read-only (a private app token with CRM read scopes). It writes the same `ffa/1` JSON, so the dashboard works unchanged.

## License

MIT
