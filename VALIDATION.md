# Historical evaluations

## Version 4 diluted earnings numerator

Evaluation date: November 7, 2026. Baseline: `forward-fundamentals-3`, commit `9710a37`. Candidate: `forward-fundamentals-4`. Inputs: SEC Company Facts and submissions fetched November 7, 2026, cut off at that date, for the 60 issuers of the version 2 split; both versions read the same snapshots. Forecast coefficients are unchanged. Nothing was tuned on these results.

Prompt: TeraWulf's 10-Q for the quarter ended September 30, 2026 reports 709.9M net income available to common shareholders but diluted EPS of -0.03: the diluted numerator removes a 728.4M warrant fair-value gain, leaving -18.5M over 573.6M diluted shares. Version 3 would divide 709.9M by 573.6M (1.24 a share). WULF's P/E was and remains withheld for losses (seven of its eight input quarters on basic earnings, all eight on the diluted numerator), so no WULF estimate changes. The defect is general: on SEC frames for calendar Q2 2026, 588 of 2,338 filers with positive basic earnings and diluted shares tag a diluted numerator, and 71 of those differ from basic by more than 2%. Restaurant Brands (exchangeable partnership units) and TPG run 23% and about 50% below their reported diluted EPS on the basic numerator; Hertz (warrant gain) runs 0.15 against a reported 0.05. Each is withheld today by an unrelated guard.

| Issuer | Version 3 | Version 4 | Cause |
| --- | --- | --- | --- |
| WYNN | forward EPS 3.84 | forward EPS 3.59 | Diluted numerators reflect a subsidiary's dilutive securities (Q1 2026: 108.0M against 120.5M basic; 108.0M / 103.8M shares = the reported 1.04). Its fourth quarter is differenced from a year and nine months that each reproduce their reported EPS on the same dilution |
| ADI | 19 scored earnings windows | 18 | The 2019-08-21 cutoff derives fiscal 2018's fourth quarter from an annual on the old revenue standard less nine months restated to the new one (393M, not 433M); the reported 1.15 EPS exposes it |

A differenced fourth-quarter diluted numerator needs that confirmation. Blackstone's exchangeable units were dilutive in the first three quarters of 2017 and antidilutive for the year (its annual diluted numerator equals basic), so its year less nine months gives -643M against 281.6M basic and a reported fourth-quarter EPS of 0.42; version 4 does not use it (that quarter also lacks a share count, so P/E is withheld for missing inputs). WYNN's fourth quarter of 2024 is left `unconfirmed`: its year is adjusted from basic while its nine months are not, though each reproduces its own EPS.

Realized earnings outcomes also use the diluted numerator. On windows with identical inputs, outcomes and baselines, errors are identical: development 651 revenue and 202 earnings windows, holdout 669 and 259. The 11 other scored windows whose inputs or outcomes move (TSCO 5, VLO 5, TTWO 1, each by at most 1M) have the same model and baseline errors to four decimals. Unscored realized outcomes move for BX (3 windows, +368M to +696M, its unit exchange add-back), WYNN (10, -11M to -25M), ALB (2, +42M), and ON, NEE, MGM, NUE and TTWO (each within 3M). The same limits apply as for earlier versions.

## Version 3 coverage revision

Evaluation date: November 1, 2026. Baseline: `forward-fundamentals-2`, commit `8bcd61e824e1c9ca03d16ce11cc4319fbc7dcb2a`. Candidate: `forward-fundamentals-3`. Inputs: SEC Company Facts and submissions for every issuer, fetched November 1, 2026, cut off at that date; both versions read the same snapshots. Forecast coefficients are unchanged. Nothing was tuned on these results.

Changes, all rules over filed data with no company lists:

- The financial exclusion covers banks, non-bank lenders, broker-dealers, insurance carriers (managed care included), property lessors and REITs, investment offices and blank checks, instead of all of SIC 6000-6799. Finance services (6199), exchanges (6200), investment advice (6282), insurance brokers (6411), general real estate (6500), real-estate services and royalty owners are modeled like other filers.
- A filer whose top line is `RevenuesNetOfInterestExpense` is excluded whatever its SIC. Without this, American Express and Ameriprise would have entered with a partial revenue line.
- Revenue re-filed under a different tag is differenced as one line when every figure differenced closes its own filing's income statement. Applied Digital's fiscal 2025 and 2026 fourth quarters now resolve to 51.1M and 258.7M; its fiscal 2026 fourth-quarter earnings release states 258.7M and 407% growth on the prior-year quarter (51.0M). The previous adapter derived -33.3M and left the 2026 quarter out.
- P/E is withheld when diluted shares move more than 25% between adjacent quarters. Booking Holdings and Texas Pacific Land have splits restated in some periods only, so every year-over-year comparison looked flat while quarterly EPS mixed share bases.

### Coverage, 503-ticker universe

The universe is the 503 S&P 500 tickers in the application's SPY-derived index file. Revenue estimates give forward P/S; P/E needs a positive EPS estimate.

| | Version 2 | Version 3 |
| --- | ---: | ---: |
| Revenue estimates | 358 | 378 |
| P/E estimates | 164 | 169 |
| Withheld as unsupported basis | 98 | 77 |
| Withheld P/E, share-basis discontinuity | 2 | 4 |

Newly estimated: CBOE, CBRE, ICE, MRSH, NDAQ and WTW with P/E; AJG, AON, APO, ARES, BEN, BRO, BX, CME, COIN, ERIE, IVZ, KKR, TPL and TROW with revenue only. BKNG loses its P/E (share basis above). SYF enters eligibility but has no revenue line in the candidates and stays withheld (insufficient history). APO and KKR consolidate insurers (premiums are 8% and 17% of 2025 revenue), so their revenue includes premiums and investment income; it is their reported top line, the one published P/S uses, and their P/E stays withheld. No premium-share threshold separates them from CVS (34%).

| Ticker | SIC | Version 2 | Version 3 |
| --- | ---: | --- | --- |
| NBIS | 7370 | insufficient-history | insufficient-history |
| CRWV | 7372 | revenue-regime-change | revenue-regime-change |
| IREN | 6199 | unsupported-basis | revenue-regime-change |
| APLD | 7374 | inconsistent-revenue-basis | revenue-regime-change |
| CORZ | 6199 | unsupported-basis | revenue-regime-change |
| WULF | 6199 | unsupported-basis | revenue estimated, P/E withheld (losses) |
| HUT | 6199 | unsupported-basis | revenue-regime-change |

The growth guard is unchanged; where it now withholds, the reason is the real one. NBIS files annual 20-F reports, so Company Facts has no quarters; its fiscal 2025 revenue (529.8M) is 5.8 times fiscal 2024 (91.5M), which the growth guard would withhold even with eight extracted quarters.

### Historical errors

Same method as version 2: errors relative to realized revenue, and net-income errors relative to trailing-year revenue so losses stay scored. Each version is scored on its own realized windows against the repeat-trailing-year baseline for those windows. The recorded split below is the version 2 issuer list; VYLR and P are no longer in the universe file, so development has 28 companies.

| Split | Metric | Version | Companies | Windows | Model (pooled) | Baseline (pooled) | Model (equal weight) | Baseline (equal weight) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| holdout | revenue | 2 | 25 | 657 | 10.39% | 11.79% | 11.02% | 12.30% |
| holdout | revenue | 3 | 25 | 660 | 10.35% | 11.77% | 10.98% | 12.27% |
| holdout | earnings | 2 | 18 | 268 | 3.56% | 3.66% | 3.70% | 3.86% |
| holdout | earnings | 3 | 18 | 265 | 3.57% | 3.68% | 3.70% | 3.87% |
| development | revenue | 2 | 20 | 561 | 13.53% | 13.94% | 14.39% | 14.72% |
| development | revenue | 3 | 23 | 611 | 13.51% | 13.85% | 15.29% | 15.08% |
| development | earnings | 2 | 13 | 167 | 4.22% | 4.39% | 6.52% | 6.52% |
| development | earnings | 3 | 15 | 201 | 4.07% | 4.11% | 6.40% | 6.20% |

On the holdout, version 3 keeps its margin over the baseline on both weightings. FISV gains three realized windows from the revenue reconciliation. TSCO and MKC each lose three earnings windows to the adjacent-quarter share check in the year after a split. On the 657 revenue and 262 earnings windows both versions score, their errors are identical. Development gains TPL, BX and MRSH from the narrower exclusion. With each company weighted equally, development revenue and earnings now trail the baseline: the newly admitted firms' growth and margins are harder for the mechanical model than the average. That is a reason to keep the model in research, not to re-exclude them.

Re-running the hash split on the current universe moves CPAY and SNPS into development and adds BG and BR to the holdout. On that split the holdout also keeps its margin: revenue 10.47% against 11.80% (version 2: 10.51% against 11.82%), earnings 3.62% against 3.72% (3.60% against 3.70%).

The same limits apply as for version 2: overlapping windows, today's surviving members, current restatements as outcomes, filing-date reconstruction rather than original-ingestion replay.


# Version 2 historical evaluation

Evaluation date: October 25, 2026. Baseline: model `forward-fundamentals-1`, repository commit `07503eb60a043a35450088a36b6ca6a12f579756`. Candidate: `forward-fundamentals-2`.

## Experiment

Version 2 uses half the median historical year-over-year revenue growth for its base forecast. No other forecasting coefficient or eligibility threshold was tuned. This single candidate was specified before inspecting the development results; the same coefficient was then evaluated on the fixed holdout without revision. Neither published multiples nor holdout results were used to fit coefficients. This is a company holdout from the previously collected current-universe snapshots, not previously unseen input data.

The current S&P membership snapshot contained 503 symbols. Deduplicate by CIK and exclude the original eight development companies (AAPL, AMZN, Alphabet's GOOG/GOOGL classes, JPM, META, MSFT, NVDA, WMT). Sort the remaining issuers by SHA-256 of `forward-v2-validation:` plus ten-digit CIK. The first 30 form development and the next 30 form holdout. Keep excluded or unscored companies in the sample record.

- Development: NOC, INTC, TPL, WY, CHRW, SNA, MCHP, HLT, NEE, BIIB, ELV, TTWO, VYLR, ETN, VTR, ON, BX, EXPD, DVA, MGM, NFLX, ALB, WYNN, XYZ, AMCR, BLK, SPG, P, MRSH, ADP.
- Holdout: CPAY, SNPS, DECK, VRSK, FISV, KIM, VICI, MAA, IR, TSCO, DOW, COR, PNW, ADI, GDDY, ADM, CMCSA, MLM, MKC, TRGP, LULU, EFX, NUE, VLO, NXPI, FDS, UDR, MDLZ, LYB, ARE.

## Paired results

Only identical cutoff dates, forecast horizons, realized outcomes and baseline values are paired. Revenue error is absolute error / realized revenue. Earnings error below is absolute net-income error / trailing-year revenue known at prediction time, so losses and zero earnings remain scored. Do not compare the two rows' magnitudes as if they measured the same thing.

| Split | Metric | Companies scored / selected | Paired windows | Version 1 | Version 2 | Repeat trailing year |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| development | revenue | 21 / 30 | 584 | 16.20% | 13.40% | 14.07% |
| development | earnings | 13 / 30 | 165 | 4.30% | 4.27% | 4.44% |
| holdout | revenue | 25 / 30 | 648 | 12.41% | 10.41% | 11.81% |
| holdout | earnings | 18 / 30 | 266 | 3.72% | 3.52% | 3.62% |

The preceding table weights every historical window equally. With each scored company weighted equally instead:

| Split | Metric | Version 1 | Version 2 | Repeat trailing year | Companies improved vs version 1 |
| --- | --- | ---: | ---: | ---: | ---: |
| development | revenue | 17.19% | 14.24% | 14.80% | 17 / 21 |
| development | earnings | 6.64% | 6.53% | 6.52% | 9 / 13 |
| holdout | revenue | 13.12% | 11.05% | 12.33% | 21 / 25 |
| holdout | earnings | 3.74% | 3.64% | 3.81% | 13 / 18 |

Holdout earnings scoring includes 5 nonpositive realized outcomes. Positive-outcome earnings MAPE, the older measure, fell from 31.87% to 30.47% over 261 paired windows; the trailing-year baseline scored 30.44%. This measure alone omits losses and can be dominated by small positive denominators.

## Interpretation

Damping improves pooled revenue error versus both version 1 and the trailing-year baseline on this holdout. Earnings results need to be judged against the baseline on both weighting schemes, not merely against the weaker first version. These exploratory results do not establish production readiness, a confidence interval or superiority for every company. The model remains research-only.

Windows overlap and are not independent. The sample contains today's surviving index members and excludes the initial development firms. Outcomes use current restatements. Inputs are reconstructed from publication dates, not original-ingestion archives. Scored coverage is incomplete, and net-income results do not establish EPS accuracy or verify corporate actions.

## Coverage and audit

A repeat of the 503-ticker current snapshot leaves coverage unchanged: 146 P/E estimates and 332 revenue estimates. Only PLTR has a P/S model estimate in the eight-company neocloud/PLTR comparison. The original README graphs remain explicitly labeled version 1; they are not charts of version 2.

The new evaluator counts withheld cutoffs, duplicate horizons and incomplete realized windows. It also counts missing earnings outcomes and earnings withheld within realized windows. Reasons are not relaxed to inflate coverage. Financial SIC classification, foreign-issuer quarterly coverage, APLD's incompatible cumulative revenue bases and rapid business transitions remain unresolved.

| Holdout company | Revenue windows v1 / v2 | Positive-earnings windows v1 / v2 | V2 earnings windows including losses |
| --- | ---: | ---: | ---: |
| CPAY | 31 / 31 | 21 / 21 | 21 |
| SNPS | 31 / 31 | 3 / 3 | 3 |
| DECK | 26 / 26 | 0 / 0 | 0 |
| VRSK | 14 / 14 | 11 / 11 | 11 |
| FISV | 21 / 21 | 9 / 9 | 9 |
| KIM | 0 / 0 | 0 / 0 | 0 |
| VICI | 0 / 0 | 0 / 0 | 0 |
| MAA | 0 / 0 | 0 / 0 | 0 |
| IR | 25 / 25 | 7 / 7 | 10 |
| TSCO | 23 / 23 | 23 / 23 | 23 |
| DOW | 22 / 22 | 0 / 0 | 0 |
| COR | 31 / 31 | 8 / 8 | 8 |
| PNW | 31 / 31 | 0 / 0 | 0 |
| ADI | 31 / 31 | 19 / 19 | 19 |
| GDDY | 27 / 27 | 0 / 0 | 0 |
| ADM | 31 / 31 | 0 / 0 | 0 |
| CMCSA | 32 / 32 | 16 / 16 | 16 |
| MLM | 31 / 31 | 23 / 23 | 23 |
| MKC | 32 / 32 | 27 / 27 | 27 |
| TRGP | 16 / 16 | 5 / 5 | 5 |
| LULU | 31 / 31 | 27 / 27 | 27 |
| EFX | 28 / 28 | 19 / 19 | 19 |
| NUE | 19 / 19 | 0 / 0 | 0 |
| VLO | 17 / 17 | 10 / 10 | 12 |
| NXPI | 20 / 20 | 11 / 11 | 11 |
| FDS | 21 / 21 | 20 / 20 | 20 |
| UDR | 0 / 0 | 0 / 0 | 0 |
| MDLZ | 30 / 30 | 2 / 2 | 2 |
| LYB | 27 / 27 | 0 / 0 | 0 |
| ARE | 0 / 0 | 0 / 0 | 0 |

## Reproduction

Use the offline comparison command in METHODOLOGY.md with `--exclude AAPL,AMZN,GOOGL,GOOG,JPM,META,MSFT,NVDA,WMT`, `--count 30` and the frozen baseline commit above. The manifest contains all current-index symbol/CIK pairs. The initial run compared both modules in one offline process; the committed comparison script reproduces the same issuer partitions and scoring. It fails on missing files rather than silently removing companies.

Raw snapshots and detailed fold outputs are retained outside Git, not redistributed with this release. Re-fetching current SEC facts may change the result. The following SHA-256 values fingerprint each parsed raw input (`JSON.stringify` of the input object), not its original whitespace. The reusable CLI additionally records byte-level hashes for supplied files.

| Split | Symbol | CIK | Parsed-input SHA-256 |
| --- | --- | --- | --- |
| development | NOC | 0001133421 | `c7e7d9d807091e27ae2fbbd5e6c8c932d30ac8c1f516b668cf25c86552fef348` |
| development | INTC | 0000050863 | `38ef66beeb6eb0aab6b4101e12ca4d99a736f388775266bfaa63798f141323f1` |
| development | TPL | 0001811074 | `699de37154411e407df7f5882bda1fad36c2b1c48212f8956b506d089be1cb04` |
| development | WY | 0000106535 | `ba5f35c615f99721859fab38232343acfdc37acb44363a160224203256cf3256` |
| development | CHRW | 0001043277 | `629ffc4e9fcd2a32027cca8f64db50c688773cc3bc2dae6e982e1ddaa92e9176` |
| development | SNA | 0000091440 | `2a37729ad107c5ee036da0fc6b48a9c2ea5b0659b0e12fd5525f0dd0a90bbe1c` |
| development | MCHP | 0000827054 | `8adcf1dae1154a21bb8544853984026847aaab59312aeb56ac805b193a5eca1e` |
| development | HLT | 0001585689 | `81b61b1a664ee5f170b741995d9a403bf14decb44eebe6ab00fbd5ce6a14b9c3` |
| development | NEE | 0000753308 | `d4d09023e1a8578124fee9362701abe1f26ebd501ebbb3891069e74f2e43ee7b` |
| development | BIIB | 0000875045 | `c679ff8d7dd33f3438abb0e33b66e548f2a13544ea28a0a88b045f358d92d9fe` |
| development | ELV | 0001156039 | `db4f9e76e6ad829bad270478ee8db81ea0ca7f7b7570342596543c73e99e9ff0` |
| development | TTWO | 0000946581 | `15da635870fd4be1bb2f5b6f0de22bbd110db4901cbe27e51d851697c77491b0` |
| development | VYLR | 0002128626 | `f51110ca1c0b953473b72077e6f58a1f506c7c67bdf84d28abfc8bc437ece61b` |
| development | ETN | 0001551182 | `0d035c24d2792dee5c2fafc87389cbcf4b83063ccb05b934c7d4239e7c6d5f83` |
| development | VTR | 0000740260 | `ac60fb0ec1ac196059ae8d165aac54b1f55dbf9e35679c94f24c12f7e844e878` |
| development | ON | 0001097864 | `ca7a42df09034f03accb3d3316fe5d65c4c916afdab6b13f3b24ca2d9d5285d6` |
| development | BX | 0001393818 | `77a4e92b9ad1b8610753036d979cb45e2d3bd2ff8d8a208b99bec29bfa322309` |
| development | EXPD | 0000746515 | `3f3c13c3ebc5a4f0053480484259166e69db2f717677dc73172df389d4ffe7c5` |
| development | DVA | 0000927066 | `49035e510adb472a0b305f060ff2b446050e925f90d3447e881f6f41717a0fb8` |
| development | MGM | 0000789570 | `b858184e2fb86302caae6691f1efe1bd1b62131c5f0a7a4a458a26f929c1213c` |
| development | NFLX | 0001065280 | `11df2fd5e59e1325d4d13038cda69c1c35401bc4ab050e92f369b2efcd50602a` |
| development | ALB | 0000915913 | `b5c7631544af4a02875a3fed7e9093895326ebba75dbd9fa4a033c5f060f3a9b` |
| development | WYNN | 0001174922 | `faa712f00282891376dbc518a2b263450523a202e323bae5cd90654fcb135497` |
| development | XYZ | 0001512673 | `ab6df5d7cc59e5caeaaa8941f000ddcae0bfaf4bd0e2e83d272da4917be5c0b4` |
| development | AMCR | 0001748790 | `3fc3e9d43b6ac3ceeaa2a63fbc9aed4ced13922abff5936de52f642cb7404e47` |
| development | BLK | 0002012383 | `142c152c5b78f134efb01cca57768be67ee5ce5c33d3265700d3838d18387450` |
| development | SPG | 0001063761 | `17f8525aa3cddc934c51ff5cbc4744dc5c6f52dc60b28fa08de5b836d673e078` |
| development | P | 0001474432 | `588066df82a3fa789f2cb29794fd4cbd9ed3dd8e603dc7273f9119120dc99bb6` |
| development | MRSH | 0000062709 | `873dffd5c698a9bdd6e09bb845f5f58361f35b2243824c83f88b11a1bf55b360` |
| development | ADP | 0000008670 | `d8f5a4ac572fe7f968cd2ae38af50c1ed09e0e9683f66c48ee544b0a62fc1e58` |
| holdout | CPAY | 0001175454 | `2759f78de3414aa9e4c885030d11b7157628982e9b12882fb3a9d645e63bb235` |
| holdout | SNPS | 0000883241 | `748718581262ed1d190692ee013dcc910b61e87fa90ffd267c4dc0f5c49069bc` |
| holdout | DECK | 0000910521 | `3c75cd878300804a8d3e9a0aa081bc0b17baee6404918541ffdfa78660d64e43` |
| holdout | VRSK | 0001442145 | `79c7bdf2f8f7f4cf9c7a265819cee048fdefefe8537c59fd380fb553f2c5db9d` |
| holdout | FISV | 0000798354 | `5f9cfd796563d81131a15af6b8a5bb81029db75b6d37b14554f8a10d296e9634` |
| holdout | KIM | 0000879101 | `52bf92d2fcfee16f5ed985ccd14a39fba3a6d26ebc35edfbc5b213302200e669` |
| holdout | VICI | 0001705696 | `0448a40559de2e91bb5275bc6f68ae6258790a1973f5dc18cc457618f61ecbf3` |
| holdout | MAA | 0000912595 | `e0dcce78988b914434ab74ef55ecd0b2276c2f66d215bb5f450345723e3d2fc9` |
| holdout | IR | 0001699150 | `a0871e3871f53c9c56f176db73108bb2bc194df39929c9d5e72f0552e5f9866b` |
| holdout | TSCO | 0000916365 | `2ff5b5936368d6eefe2170bf248d361faee2e15a748b8f7e0d95eb817f7f3a90` |
| holdout | DOW | 0001751788 | `abe9828011ef9395c34cbcf3ba61d7beaef649653c0e0be5fa89e18b1a310037` |
| holdout | COR | 0001140859 | `d474805e477293a0c624a391a1fd0da3fdb47d876f338ad8c518bc8f1fdfa08a` |
| holdout | PNW | 0000764622 | `a2dd9ecb4784aa6bc25090daef267190d759cf8a9a8bc6daf4840677f5b78a54` |
| holdout | ADI | 0000006281 | `c4a09d77b8fabc68391d97b27aa53f132510b093f760fa154c5bba3a8ea56ba6` |
| holdout | GDDY | 0001609711 | `c44f1fa23321ea5da6f407af3b0edd70cd4a5e54d21032d0cf313fd21f87859c` |
| holdout | ADM | 0000007084 | `3541e0a4ca20ed1b22077605f870ed3370d35e21a770419c873b1649f9ecad78` |
| holdout | CMCSA | 0001166691 | `10372b6bba6c7e62d3114f0832de0893037c89286795d5eecc1719606a3db65c` |
| holdout | MLM | 0000916076 | `db2bfde30e97553e1c444eb13b3480961df82beca800d27766fd5014a2e015d4` |
| holdout | MKC | 0000063754 | `723e0a5e3452cf95ed4999fe86e71482d2dd59132d13b9829328a2d914665f2b` |
| holdout | TRGP | 0001389170 | `c46a9616eecb6fbb220b9d9f75d7666701341dfd871250dcec8b42121d5a9d03` |
| holdout | LULU | 0001397187 | `dc7eb9a5c97e71745135b91f4d652feaceed849e71c35baea6a0c3f2850e9d83` |
| holdout | EFX | 0000033185 | `09b580b5f5747b06497d9eb8b6504f30c59db03cf6b22767d5ea2c300bcbecb5` |
| holdout | NUE | 0000073309 | `d4134e5082fd276423f25f6c11439b91af75ba19bad6145295656bfbd0ee6874` |
| holdout | VLO | 0001035002 | `3ad6d25511b3e718f63d98173b2b18611eba88c7b968c0def4c9285ea4e6e5d6` |
| holdout | NXPI | 0001413447 | `24d38e43530bdf99d6826841db5d7e41e962941aac0818e4a61d292c06922024` |
| holdout | FDS | 0001013237 | `d13019f9b05a90ff31333aba990f60a62dbe858da0cded2a558c3fe10f93146d` |
| holdout | UDR | 0000074208 | `c7f8aee1d83e13da052e321db576252ecc2b56f13e220cb063652ca9887aa3c5` |
| holdout | MDLZ | 0001103982 | `401bc260003d0ddf7584bda3c75f30321fdace53a91084c5c85aab4781a52c95` |
| holdout | LYB | 0001489393 | `960d125e0b1c22136e5cd95df63c014177597a349a4b8d8778e3f99cf03c4f1c` |
| holdout | ARE | 0001035443 | `45bd9505d13e1fd51fe4c94e8df2f68f8fd5175886370e9c4eaa12ef3fe5cf42` |
