# Methodology

## Method and scope

`docs/core/forward-valuation-model.js` is pure and shared. The SEC adapter and offline evaluator
live in `scripts/forward-valuation-inputs.mjs` and `scripts/evaluate-forward-valuation.mjs`.

The input is eight contiguous quarters, with start/end dates, publication dates, currency and
source evidence. Revenue is projected as `prior-year quarter revenue × (1 + 0.5 × median year-over-year growth)` for each of the latest four quarters (version 2). This halves both growth and contraction extrapolation while preserving seasonality. The 50% damping is a fixed conservative assumption, not fitted to published multiples. Low/high growth moves
around that dampened base by the larger of five percentage points and 1.4826 times the median absolute deviation of growth.
These are sensitivity scenarios, not statistical confidence intervals.

For positive-earnings companies, quarterly operating margin is the average of the corresponding
prior-year margin and the recent revenue-weighted margin. Add the median recent non-operating
income/revenue ratio, subtract tax at the median recent effective rate, and subtract the median
reconciliation from post-tax income to common earnings. Project diluted shares from the latest
quarter with the median year-over-year share-count change. Divide each quarter's net income by
its forecast diluted shares and sum EPS. Low/high scenarios additionally move operating margin
by two percentage points, tax by two points and annual share growth by one point.

This approximates an income-statement forecast mechanically. It does not recreate a sell-side
analyst's company research or consensus adjustments. Its earnings basis uses GAAP inputs and
normalized historical assumptions, not a claim to future reported GAAP EPS. There are no price
targets, fair-value claims, trade signals or portfolio personalization.

The horizon is the **next four unreported fiscal quarters**, beginning after the last reported
quarter. It can include a quarter already elapsed but not yet reported. It is not rolling NTM,
next fiscal year, or the next four quarters after today's date. Calendar fiscal quarter boundaries advance by year, accounting for leap dates. Week-based future
quarter dates assume 52 weeks and are explicitly marked estimated because the next 53-week year
is not established by historical companyfacts alone. Output carries this distinction.

Optional management revenue guidance must exactly match the model horizon, currency and revenue
basis, carry an HTTPS source and publication date, and be no older than the latest input publication.
Accepted low/high guidance rescales seasonal revenue. Mismatched guidance is explicitly rejected;
ARR and backlog are never accepted as revenue. Automatic guidance extraction, segment-driver
forecasts and guidance fiscal-period conversion are outside this first research implementation.

## Eligibility and accounting safeguards

- Eight contiguous quarters with positive revenue, publication dates no later than the cutoff and
  latest reported period no more than 185 days old. A year-over-year revenue change outside
  -50% to +100% withholds the model rather than clipping a structural change into a plausible result.
- Adapter coverage is US GAAP, USD, with an explicit SIC from SEC submissions. Missing SIC, IFRS
  and explicitly unresolved share bases are excluded. SIC is read from today's submissions file, not as of each
  historical cutoff. Financial SIC codes are excluded only where
  the business has no revenue line and operating margin in this model's sense: banks and savings
  institutions (6000-6099), non-bank lenders, finance lessors and asset-backed issuers (6100-6189),
  broker-dealers (6211-6221), insurance carriers (6300-6399, managed care included), property
  operators and lessors (6510-6519) and REITs (6798), holding and investment offices and blank checks (6700-6791), and
  investors not elsewhere classified (6799). Finance services (6199), exchanges (6200), investment
  advice (6282), insurance brokers (6411), general real estate (6500), real-estate services and
  developers (6520-6599) and
  royalty owners (6792-6795) face the same per-company guards as every other filer. The ranges
  name kinds of business, never companies; `UNSUPPORTED_SIC_RANGES` gives each one's reason.
  Whatever its SIC, a filer that reports `RevenuesNetOfInterestExpense` in a periodic report
  ending within 400 days of the cutoff earns an interest spread in its top line (a card issuer
  under 6199, a wealth manager under 6282) and is excluded: none of the adapter's revenue
  candidates is that total, so the resolved line would be a part of revenue.
- Revenue resolution reuses the existing quarterly flow reconstruction and partial-revenue detector.
  Only facts published by the cutoff enter the resolver; subsequent restatements cannot enter training.
- Revenue is also resolved as one line across its candidate tags before cumulative differencing:
  for each reported period, the latest filed figure from the whole-revenue tags (a partial tag only
  for a period no whole tag reports). A quarter from that line fills a quarter the per-tag series
  lacks or replaces one it derived below zero, only when it is positive, and, when it differences
  figures from more than one tag, only when each figure closes its own filing's income statement
  (less cost of revenue it gives the filed gross profit, or less total costs the filed operating
  income). Such a quarter carries `revenueReconciled: true`.
  Not detected: an annual restated for a disposal set against a year-to-date figure that was
  not restated. Both close their own statements, so the derived fourth quarter is understated
  by the disposed business's revenue; it is withheld only if it falls to zero or below. This is the
  case of a 10-K that restates the year under a new tag after 10-Qs on the old one: per tag, the
  restated annual cannot be paired with its own year to date, and the stale annual gives a
  negative fourth quarter. A quarter still below zero stays an input-basis error.
- Diluted weighted shares use direct quarterly facts, or annual minus nine-month **share-days**,
  divided by quarter days. Share counts are not additive revenue flows. The annual Q4 derivation
  is an approximation to reported weighted averages, not a reconstruction of the diluted EPS rules.
- Missing earnings inputs, nonpositive profits, diluted share changes above 25% year over year or
  between adjacent quarters (version 3: a split restated in some periods only repeats each year;
  this also withholds P/E for up to a year after an ordinary split, until the filer's comparatives
  are all on the new basis), negative
  or above-60% recent effective taxes, non-operating income above 15% of quarterly revenue, and
  common-earnings reconciliation above 3% of revenue withhold P/E. Revenue can remain available.
- Ordinary equity/share basis must be verified by the caller. ADR conversion, complex capital
  structures, subsequent splits and corporate actions require the existing production share-basis
  resolver before any rollout. The research adapter is not a universal security master.
- Price and market cap must be finite and positive, match the currency/common-share basis, and have
  a dated price no more than seven days before the forecast date. The valuation result preserves
  the complete quote, including any dated SEC share-count evidence supplied by the caller.

## Running and reproducing

No network, secrets, production writes or scheduled jobs are inside the evaluator. Supply raw
SEC companyfacts JSON files named by ticker, enriched with `sic` from the same issuer's SEC
submissions. Any symbol with appropriate evidence can be used; there is no maintained ticker list.
Retain these input snapshots outside Git because SEC companyfacts changes as filings arrive.
The report records a SHA-256 fingerprint of each parsed raw companyfacts input.

```sh
node scripts/evaluate-forward-valuation.mjs \
  --input-dir /path/to/research-inputs --symbols AAPL,MSFT \
  --as-of 2026-10-25 --quotes /path/to/quotes.json \
  --references /path/to/references.json --backtest --out /path/to/results.json
```

Quotes are a JSON object keyed by symbol, each with `price`, `marketCap`, `date`, `currency`,
`source` and `shareBasis: "common"`. `--quotes` is optional for forecast-only evaluation.
References are keyed by symbol with `url`, `observedAt`, `priceDate`, `price`, `forwardPE`,
`currency`, and explicit `earningsBasis` and `horizon` notes. They never enter forecast computation.
`--guidance` optionally names a symbol-keyed JSON object with the guidance fields above.

Reference comparison computes the source-implied EPS (source price divided by source P/E), model
P/E at the source's own price, model P/E at the supplied Twelve Data price, and EPS difference.
It is always marked context-only: without verified identical horizons and accounting bases,
agreement is not evidence of forecast accuracy. Invalid or stale references are rejected.

The backtest reconstructs inputs at periodic-report publication dates from 2018 onward, keeps one
fold per forecast horizon, and evaluates only four realized consecutive quarters. Its benchmark
repeats the latest reported four-quarter revenue and net income. Report mean absolute percentage
error and the proportion of folds beating that baseline on identical eligible samples. Net-income
errors require positive realized net income; negative outcomes and withheld forecasts do not
contribute to the percentage-error score. Current restatements supply realized outcomes, while
historical publication cutoffs govern training. This is a filing-date reconstruction, not an
original-ingestion replay. Windows overlap and the selected sample has survivorship bias.

## Version 2 evaluation

The historical evaluator now reports the reason/count for every withheld cutoff, duplicate horizon and incomplete realized window. For realized windows it separately reports withheld earnings forecasts and missing earnings outcomes. These counts describe cutoff attempts, not unique companies or independent observations.

MAPE remains restricted to positive realized outcomes. A second earnings score is absolute net-income error divided by the trailing-year revenue known at prediction time. It includes zero and negative realized net income, uses the same denominator for model and baseline, and is reported separately from MAPE. Forecasts withheld before the outcome are counted rather than assigned an invented prediction. Revenue has its own positive-outcome eligibility.

A negative quarter reconstructed by subtracting cumulative revenue is withheld as `inconsistent-revenue-basis`; source evidence remains available. In version 2 nothing filled missing quarters or repaired restatements; version 3's one-line reconciliation (above) does so only under its income-statement condition. Directly filed negative revenue still fails the existing positive-revenue guard. Extreme-growth guards remain unchanged pending a verified alternative. Version 3 narrows the SIC exclusion, adds the interest-spread exclusion and the one-line revenue reconciliation in the adapter, and adds the adjacent-quarter share check to the engine. Forecast coefficients are unchanged; see VALIDATION.md, "Version 3 coverage revision".

The offline `scripts/compare-history.mjs` compares this checkout with a frozen baseline checkout. Supply a JSON manifest of `{ "symbol": "EXAMPLE", "cik": "0000000001" }` rows and raw SEC snapshots named by ten-digit CIK. It deduplicates issuers, excludes all share classes of prior development firms, then sorts by SHA-256 of `forward-v2-validation:` plus padded CIK. The first 30 issuers are development and the next 30 are holdout; choose the split before inspecting outcomes. It reports paired errors for identical cutoffs, horizons, realized outcomes and baselines, both pooled and with equal company weights.

```sh
node scripts/compare-history.mjs --manifest /path/to/manifest.json \
  --input-dir /path/to/snapshots --baseline-root /path/to/v1-checkout \
  --split holdout --as-of 2026-10-25 --out artifacts/holdout.json
```

This is an issuer holdout within today's surviving universe, not a survivorship-free or prospective experiment. Overlapping forecast windows are correlated. Missing raw snapshots cause a failure rather than silently removing a selected company. See [VALIDATION.md](VALIDATION.md) for the recorded selection, prior-development exclusions, versions and results.
