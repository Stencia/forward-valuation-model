// SEC adapter for the research model. Filter publication dates BEFORE selecting/reconstructing quarters.
import { operatingQuarterSeries } from './sec-operating-quarters.mjs';
import { partialRevenueConcepts, withPartialRevenueLast } from './sec-revenue-components.mjs';
import { daysBetween, matchesReportedEps, validDate } from '../docs/core/forward-valuation-model.js';
const tags = (names) => names.map((n) => ['us-gaap', n]);
const REVENUE = tags(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet',
  'RevenueFromContractWithCustomerIncludingAssessedTax']);
const METRICS = {
  operatingIncome: tags(['OperatingIncomeLoss']),
  pretaxIncome: tags(['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments']),
  tax: tags(['IncomeTaxExpenseBenefit']),
  netIncome: tags(['NetIncomeLossAvailableToCommonStockholdersBasic', 'NetIncomeLoss']),
};
// The diluted-EPS numerator: basic earnings after the filer's own dilutive-security adjustments,
// including a subsidiary's dilutive securities (Wynn Resorts tags only the second concept). Each
// concept is resolved on its own, so neither displaces the other by filing date.
const DILUTED_NUMERATORS = ['NetIncomeLossAvailableToCommonStockholdersDiluted', 'NetIncomeLossAttributableToParentDiluted'];
const DILUTED_EPS = ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'];
// SEC SIC codes whose reported figures do not fit this model's revenue x operating-margin bridge.
// Only these are excluded; the rest of Division H (60-67) faces the same per-company guards as any
// other filer. Finance services (6199: card networks, payment and crypto-mining/compute firms),
// exchanges and market services (6200), investment advice (6282), insurance agents and brokers
// (6411), general real estate (6500, mostly services firms), real-estate agents, managers, dealers
// and developers (6520-6599) and royalty or patent owners (6792-6795) report fee, sales or royalty
// revenue with ordinary operating expenses. Some investment advisers consolidate an insurer; their
// reported revenue then includes premiums and investment income, the top line published P/S also
// uses, and their earnings meet the same per-company guards.
// The issue the ranges answer is whether the business has a revenue line and operating margin
// in the model's sense, never which companies are in them.
export const UNSUPPORTED_SIC_RANGES = Object.freeze([
  // Banks and savings institutions: income is net interest income after credit-loss provisions.
  [6000, 6099],
  // Non-bank lenders, finance lessors and asset-backed issuers: interest-spread income and
  // provisions, the same basis as a bank.
  [6100, 6189],
  // Broker-dealers and commodity dealers: trading gains and interest income net of interest expense.
  [6211, 6221],
  // Insurance carriers: premiums earned against reserve changes, with investment income in earnings.
  [6300, 6399],
  // Property operators and lessors (not 6500, general real estate), which include REITs filed
  // under these codes: GAAP earnings move with depreciation and property-sale gains, and the
  // business is valued on FFO, which is not computed here.
  [6510, 6519],
  // Holding and investment offices, blank-check companies: no operating business of their own.
  [6700, 6791],
  // Real estate investment trusts (see 6510-6519) and investors not elsewhere classified, whose
  // earnings are investment gains.
  [6798, 6799],
]);
export const unsupportedSic = (sic) => !Number.isInteger(sic) || sic < 100
  || UNSUPPORTED_SIC_RANGES.some(([lo, hi]) => sic >= lo && sic <= hi);
// A filer whose total revenue is stated net of interest expense earns an interest spread in its top
// line, whatever its SIC: a card issuer under finance services (6199), a wealth manager under
// investment advice (6282). None of this adapter's revenue candidates is that total, so the line it
// would resolve is a part of revenue, and the margin bridge has no place for credit provisions.
// Only the filer's own recent periodic reports count (a year and a month before the cutoff).
function interestSpreadTopLine(facts, asOf) {
  return Object.values(facts['us-gaap']?.RevenuesNetOfInterestExpense?.units || {}).flat()
    .some((p) => /^10-[QK](\/A)?$/.test(p.form || '') && validDate(p.end) && daysBetween(p.end, asOf) <= 400);
}
const origins = (p) => p?.origin?.kind === 'filed' ? [p.origin] : (p?.origin?.terms || []).map((t) => t.origin);
const newest = (points) => [...points].sort((a, b) => String(b.filed).localeCompare(String(a.filed)))[0];

export function factsAsOf(raw, asOf) {
  if (!validDate(asOf)) throw new Error('A valid asOf date is required');
  return Object.fromEntries(Object.entries(raw.facts || {}).map(([ns, concepts]) => [ns,
    Object.fromEntries(Object.entries(concepts).map(([tag, c]) => [tag, { ...c,
      units: Object.fromEntries(Object.entries(c.units || {}).map(([u, points]) => [u, points.filter((p) =>
        validDate(p.filed) && p.filed <= asOf && validDate(p.end) && p.end <= asOf)])) }]))]));
}

// Weighted-average shares are NOT additive flows. Derive an absent Q4 from weighted share-days.
function sharesFor(facts, q) {
  const points = (facts['us-gaap']?.WeightedAverageNumberOfDilutedSharesOutstanding?.units?.shares || [])
    .filter((p) => /^10-[QK](\/A)?$/.test(p.form) && p.val > 0 && validDate(p.start));
  const direct = newest(points.filter((p) => p.start === q.start && p.end === q.end));
  const evidence = (p) => ({ accession: p.accn, filedAt: p.filed, concept: 'WeightedAverageNumberOfDilutedSharesOutstanding',
    unit: 'shares', start: p.start, end: p.end, value: p.val });
  if (direct) return { value: direct.val, sources: [evidence(direct)] };
  const year = newest(points.filter((p) => p.end === q.end && daysBetween(p.start, p.end) >= 350 && daysBetween(p.start, p.end) <= 380));
  if (!year) return null;
  const prior = newest(points.filter((p) => p.start === year.start && daysBetween(p.end, q.start) === 1));
  if (!prior) return null;
  const value = (year.val * (daysBetween(year.start, year.end) + 1) - prior.val * (daysBetween(prior.start, prior.end) + 1))
    / (daysBetween(q.start, q.end) + 1);
  return value > 0 ? { value, sources: [evidence(year), evidence(prior)], method: 'weighted-share-days' } : null;
}

// One filed figure for exactly this period from the first concept that has one: the given filing's
// across all concepts first, otherwise (unless strict) the newest of the first concept filed.
function filedFor(facts, concepts, unit, period, accession, strict = false) {
  const byConcept = concepts.map((tag) => [tag, (facts['us-gaap']?.[tag]?.units?.[unit] || [])
    .filter((p) => /^10-[QK](\/A)?$/.test(p.form || '') && Number.isFinite(p.val) && p.start === period.start && p.end === period.end)]);
  for (const [tag, points] of byConcept) {
    const p = accession && points.find((p) => p.accn === accession);
    if (p) return { tag, p };
  }
  if (strict) return null;
  for (const [tag, points] of byConcept) if (points.length) return { tag, p: newest(points) };
  return null;
}
// Per-share figures are not additive flows either: only a directly reported period is used, from
// the filing that supplied the share count (a later filing can restate EPS for a split the share
// count predates). A share count derived from a year and nine months takes EPS only from the
// annual's filing.
function dilutedEpsFor(facts, q, shares) {
  const derived = shares?.method === 'weighted-share-days';
  const found = filedFor(facts, DILUTED_EPS, 'USD/shares', q, shares?.sources[0]?.accession, derived);
  return found && { value: found.p.val, source: { accession: found.p.accn, filedAt: found.p.filed, concept: found.tag,
    unit: 'USD/shares', start: found.p.start, end: found.p.end, value: found.p.val } };
}
const BASIC_NET = METRICS.netIncome.map(([, tag]) => tag);
// A diluted numerator differenced from filed periods (a year less nine months) stands only when
// every figure in it reproduces its own period's reported diluted EPS over that period's diluted
// shares, and all are adjusted from basic in the same direction or none is: antidilution is tested
// per period, so a year on which the securities were antidilutive cannot be netted against nine
// months on which they were dilutive.
function confirmedDerivation(facts, q) {
  const modes = (q.origin?.terms || []).map(({ origin: o }) => {
    const period = { start: o.start, end: o.end };
    const basic = filedFor(facts, BASIC_NET, 'USD', period, o.accession)?.p.val;
    const shares = filedFor(facts, ['WeightedAverageNumberOfDilutedSharesOutstanding'], 'shares', period, o.accession)?.p.val;
    const eps = filedFor(facts, DILUTED_EPS, 'USD/shares', period, o.accession)?.p.val;
    if (!Number.isFinite(basic) || !matchesReportedEps(o.value, shares, eps)) return NaN;
    return Math.abs(o.value - basic) <= 0.01 * Math.abs(basic) ? 0 : Math.sign(o.value - basic);
  });
  return modes.length > 0 && modes.every((m) => m === modes[0]);
}

// Revenue figures one filer tags under different candidate concepts can be one line on one basis:
// a 10-K restated for a disposal tags the year's total under Revenues while every 10-Q before it
// used contract revenue (Applied Digital's fiscal 2025 and 2026). Differencing within each concept
// then pairs a year with a cumulative figure from another vintage (an annual of 144.2M less nine
// months of 177.5M gives a quarter of -33.3M) or cannot difference at all (no fourth quarter, so
// the window has a gap). This line takes, for every reported period, the latest filed figure from
// the whole-revenue candidates (a partial one only for a period no whole candidate reports) and
// differences that one line, so the annual and its year-to-date both carry the current basis.
// A difference across tags stands only when every figure in it closes its own filing's income
// statement (closesIncomeStatement).
const FLOW_FORMS = /^(10-Q|10-K|20-F|40-F)(\/A)?$/;
const IDENTITY_TOLERANCE = 0.001;
const COST_OF_REVENUE = ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfServices', 'CostOfGoodsSold'];
const TOTAL_COSTS = ['CostsAndExpenses', 'OperatingCostsAndExpenses', 'BenefitsLossesAndExpenses', 'OperatingExpenses'];
// A revenue figure is the filer's whole top line for its period when the same filing's income
// statement starts from it: less cost of revenue it gives the filed gross profit, or less total
// costs the filed operating income. Contract revenue that leaves out rent or interest does not
// close either, even in a filing where it once equalled the total (a lessor before its first lease).
function closesIncomeStatement(facts, o) {
  const at = (tag) => (facts['us-gaap']?.[tag]?.units?.USD || [])
    .find((p) => p.accn === o.accession && p.start === o.start && p.end === o.end && Number.isFinite(p.val))?.val ?? null;
  const near = (v, target) => target != null && Math.abs(v - target) <= Math.abs(target) * IDENTITY_TOLERANCE;
  const gross = at('GrossProfit');
  if (gross != null && COST_OF_REVENUE.some((tag) => { const c = at(tag); return c != null && near(o.value - c, gross); })) return true;
  const operating = at('OperatingIncomeLoss');
  return operating != null && TOTAL_COSTS.some((tag) => { const c = at(tag); return c != null && near(o.value - c, operating); });
}
function reconciledRevenueQuarters(facts, candidates) {
  const chosen = new Map();
  const conceptOf = new Map();
  const byConcept = candidates.map(([ns, tag], preference) => {
    const points = (facts[ns]?.[tag]?.units?.USD || []).filter((p) => Number.isFinite(p.val)
      && validDate(p.start) && validDate(p.end) && validDate(p.filed) && FLOW_FORMS.test(p.form || '')
      && daysBetween(p.start, p.end) >= 70 && daysBetween(p.start, p.end) <= 380);
    return { ns, tag, preference, partial: Boolean(candidates[preference].fillsGapsOnly), points };
  });
  const rank = (c, p) => [c.partial ? 1 : 0, p.filed, -c.preference];
  const better = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  for (const c of byConcept) for (const p of c.points) {
    const key = `${p.start}/${p.end}`;
    const prior = chosen.get(key);
    if (!prior || better(rank(c, p), prior.rank)) chosen.set(key, { rank: rank(c, p), point: p, concept: c });
  }
  const pointKey = (p) => `${p.accn || null}|${p.filed || null}|${p.start}|${p.end}|${p.val}`;
  const points = [...chosen.values()].map(({ point, concept }) => {
    conceptOf.set(pointKey(point), concept);
    return point;
  });
  const line = operatingQuarterSeries({ reconciled: { revenue: { units: { USD: points } } } },
    [['reconciled', 'revenue']], 'USD', { depth: 100 });
  const relabel = (o) => {
    const c = conceptOf.get(`${o.accession}|${o.filedAt}|${o.start}|${o.end}|${o.value}`);
    return c ? Object.freeze({ ...o, taxonomy: c.ns, concept: c.tag }) : null;
  };
  return line.flatMap((q) => {
    if (!q.derived) return [];
    const terms = q.origin.terms.map((t) => ({ origin: relabel(t.origin), coefficient: t.coefficient }));
    if (terms.some((t) => !t.origin)) return [];
    // Differencing across tags needs each figure to be the whole top line of its own filing.
    if (new Set(terms.map((t) => t.origin.concept)).size > 1
      && !terms.every((t) => closesIncomeStatement(facts, t.origin))) return [];
    return [{ ...q, origin: Object.freeze({ kind: 'derived', method: q.origin.method, terms: Object.freeze(terms) }),
      reconciled: true }];
  });
}

// Fills a quarter the per-concept series lacks, or replaces one it derived below zero, with the
// single-line derivation. A reconciled figure that is itself not positive changes nothing: the
// negative quarter stays an input-basis error and the gap stays a gap.
function withReconciledRevenue(series, reconciled) {
  const out = [...series];
  for (const r of reconciled) {
    if (!(r.val > 0)) continue;
    const same = out.findIndex((q) => q.start === r.start && q.end === r.end);
    if (same >= 0) {
      if (out[same].derived && out[same].val < 0) out[same] = r;
    } else if (!out.some((q) => q.start <= r.end && q.end >= r.start)) out.push(r);
  }
  return out.sort((a, b) => a.end.localeCompare(b.end));
}

export function companyFactsModelInput(raw, asOf) {
  const facts = factsAsOf(raw, asOf);
  const revenueTags = withPartialRevenueLast(REVENUE, partialRevenueConcepts(facts, REVENUE));
  const resolve = (candidates) => operatingQuarterSeries(facts, candidates, 'USD', { depth: 100 });
  const series = Object.fromEntries(Object.entries(METRICS).map(([key, cs]) => [key, resolve(cs)]));
  // Antidilution is tested period by period (ASC 260), so a diluted numerator is not additive: a
  // fourth quarter differenced from a year and nine months on different dilution can be far from
  // the quarter's own. Only directly filed quarters are used.
  const dilutedSeries = DILUTED_NUMERATORS.map((tag) => resolve(tags([tag])));
  const revenues = withReconciledRevenue(resolve(revenueTags), reconciledRevenueQuarters(facts, revenueTags));
  const quarters = revenues.map((r) => {
    const sources = [...origins(r)];
    // A negative reconstructed revenue is evidence of incompatible cumulative inputs,
    // not reported negative sales. Preserve the source evidence but withhold the value.
    const revenueBasisIssue = Boolean(r.derived && r.val < 0);
    const row = { start: r.start, end: r.end, currency: 'USD',
      revenue: revenueBasisIssue ? null : r.val, ...(revenueBasisIssue ? { revenueBasisIssue: true } : {}),
      ...(r.reconciled ? { revenueReconciled: true } : {}) };
    for (const [key, points] of Object.entries(series)) {
      const p = points.find((p) => p.start === r.start && p.end === r.end);
      row[key] = p?.val ?? null;
      sources.push(...origins(p));
    }
    const shares = sharesFor(facts, r);
    row.dilutedShares = shares?.value ?? null;
    sources.push(...(shares?.sources || []));
    const eps = dilutedEpsFor(facts, r, shares);
    row.reportedDilutedEPS = eps?.value ?? null;
    // Earnings are divided by diluted shares, so the filer's diluted numerator is preferred. With
    // a reported diluted EPS, the first numerator that reproduces it is used, basic included (some
    // filers tag the adjustment, or flip its sign, under the diluted concept). Without one, a filed
    // diluted figure more than 50% from basic, or a differenced one that its filed periods do not
    // confirm, leaves the quarter unconfirmed rather than silently on basic.
    const basic = row.netIncome;
    const candidates = dilutedSeries.map((points) => points.find((p) => p.start === r.start && p.end === r.end))
      .filter((p) => Number.isFinite(p?.val));
    const direct = candidates.filter((p) => !p.derived);
    const plausible = (v) => !Number.isFinite(basic) || Math.abs(v - basic) <= 0.5 * Math.abs(basic);
    const near = (v) => Number.isFinite(basic) && Math.abs(v - basic) <= 0.01 * Math.abs(basic);
    let chosen = null; let numerator = 'basic';
    if (eps) {
      chosen = candidates.find((p) => matchesReportedEps(p.val, row.dilutedShares, eps.value))
        ?? (matchesReportedEps(basic, row.dilutedShares, eps.value) ? null : direct[0] ?? null);
    } else if (direct.length) {
      chosen = direct.find((p) => plausible(p.val)) ?? null;
      if (!chosen) numerator = 'unconfirmed';
    } else if (candidates.length) {
      chosen = candidates.find((p) => plausible(p.val) && confirmedDerivation(facts, p)) ?? null;
      if (!chosen && !candidates.every((p) => near(p.val))) numerator = 'unconfirmed';
    }
    if (chosen) numerator = 'diluted';
    row.basicNetIncome = basic;
    if (chosen) { row.netIncome = chosen.val; sources.push(...origins(chosen)); }
    row.earningsNumerator = numerator;
    // The EPS is evidence for the check only; a later filing repeating it does not date the quarter.
    row.knownAt = sources.map((s) => s.filedAt).sort().at(-1);
    if (eps) sources.push(eps.source);
    row.sources = sources;
    return row;
  });
  const sic = Number(raw.sic);
  return { asOf, currency: 'USD', quarters, eligibility: {
    unsupportedBusiness: !facts['us-gaap'] || unsupportedSic(sic) || interestSpreadTopLine(facts, asOf),
    shareBasisUnresolved: raw.shareBasisUnresolved === true,
  }, provenance: { cik: raw.cik, name: raw.entityName,
    source: `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(raw.cik).padStart(10, '0')}.json`,
    limitation: 'SEC publication-date reconstruction, not a replay of original ingestion. Calendar and share-basis eligibility require verification.' } };
}
