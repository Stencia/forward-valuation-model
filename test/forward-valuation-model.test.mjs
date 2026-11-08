import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastFundamentals, priceForwardForecast, matchesReportedEps } from '../docs/core/forward-valuation-model.js';
import { companyFactsModelInput, factsAsOf, unsupportedSic } from '../scripts/forward-valuation-inputs.mjs';
import { comparePublished, backtestCompany } from '../scripts/evaluate-forward-valuation.mjs';
const date = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
function input() {
  const quarters = Array.from({ length: 8 }, (_, i) => {
    const y = 2023 + Math.floor(i / 4); const m = i % 4 * 3;
    const revenue = [100, 120, 130, 150][i % 4] * (i < 4 ? 1 : 1.1);
    return { start: date(y, m, 1), end: date(y, m + 3, 0), knownAt: date(y, m + 3, 25), currency: 'USD',
      revenue, operatingIncome: revenue * .25, pretaxIncome: revenue * .24,
      tax: revenue * .048, netIncome: revenue * .192, dilutedShares: 10 };
  });
  return { quarters, asOf: '2025-02-01', currency: 'USD' };
}
test('revenue seasonality, operating bridge, dilution and price math', () => {
  const f = forecastFundamentals(input());
  assert.equal(f.status, 'estimated');
  assert.ok(Math.abs(f.scenarios.base.revenue - 577.5) < 1e-9);
  assert.ok(Math.abs(f.scenarios.base.eps - 11.088) < 1e-9);
  assert.ok(f.scenarios.low.eps < f.scenarios.base.eps && f.scenarios.base.eps < f.scenarios.high.eps);
  assert.equal(f.period.start, '2025-01-01');
  const p = priceForwardForecast(f, { price: 100, marketCap: 1000, date: '2025-01-31', currency: 'USD', shareBasis: 'common', source: 'Twelve Data' });
  assert.equal(p.scenarios.base.forwardPE, 100 / f.scenarios.base.eps);
  assert.ok(Math.abs(p.scenarios.base.forwardPS - 1000 / 577.5) < 1e-12);
});
test('withhold unsafe inputs without treating missing values as zero', () => {
  for (const mutate of [x => x.quarters.pop(), x => x.quarters[6].start = '2024-08-01',
    x => x.quarters[7].knownAt = '2025-03-01', x => x.quarters[7].revenue = null,
    x => x.quarters[7].currency = 'EUR', x => x.asOf = '2026-01-01', x => x.asOf = '2025-02-30',
    x => x.eligibility = { unsupportedBusiness: true }]) {
    const x = input(); mutate(x); assert.equal(forecastFundamentals(x).status, 'unavailable');
  }
  for (const mutate of [x => x.quarters[7].tax = null, x => x.quarters[7].tax = -2,
    x => x.quarters[7].netIncome = -1, x => x.quarters[7].dilutedShares = 100,
    x => x.quarters[7].pretaxIncome *= 3]) {
    const x = input(); mutate(x); const f = forecastFundamentals(x);
    assert.equal(f.status, 'estimated'); assert.ok(f.earningsReason); assert.equal(f.scenarios.base.eps, null);
  }
});
test('guidance must match dates, currency, publication and revenue basis', () => {
  const x = input();
  const guidance = { start: '2025-01-01', end: '2025-12-31', currency: 'USD', publishedAt: '2025-01-25', sourceUrl: 'https://example.com/release', basis: 'revenue', low: 600, high: 640 };
  assert.ok(Math.abs(forecastFundamentals({ ...x, guidance }).scenarios.base.revenue - 620) < 1e-9);
  for (const patch of [{ basis: 'ARR' }, { publishedAt: '2025-03-01' }, { end: '2027-12-31' }, { currency: 'EUR' }]) {
    const f = forecastFundamentals({ ...x, guidance: { ...guidance, ...patch } });
    assert.ok(f.guidanceReason); assert.equal(f.assumptions.guidance, null);
  }
});
test('valuation rejects stale, future, nonfinite and wrong-basis quotes', () => {
  const f = forecastFundamentals(input()); const q = { price: 100, marketCap: 1000, date: '2025-01-31', currency: 'USD', shareBasis: 'common', source: 'Twelve Data' };
  for (const patch of [{ date: '2024-12-01' }, { date: '2025-02-02' }, { price: Infinity }, { marketCap: null }, { currency: 'EUR' }, { shareBasis: 'ADS' }])
    assert.equal(priceForwardForecast(f, { ...q, ...patch }).status, 'unavailable');
  const ref = { currency: 'USD', url: 'https://example.com/ratios', observedAt: '2025-02-01', priceDate: '2025-01-31', price: 120, forwardPE: 10 };
  const c = comparePublished(f, priceForwardForecast(f, q), ref);
  assert.equal(c.impliedReferenceEPS, 12); assert.equal(c.modelPEAtReferencePrice, 120 / f.scenarios.base.eps);
  assert.equal(c.status, 'context-only');
});
function rawFacts() {
  const x = input(); const facts = { 'us-gaap': {} };
  for (const [key, tag, unit] of [['revenue', 'Revenues', 'USD'], ['operatingIncome', 'OperatingIncomeLoss', 'USD'],
    ['pretaxIncome', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'USD'],
    ['tax', 'IncomeTaxExpenseBenefit', 'USD'], ['netIncome', 'NetIncomeLoss', 'USD'],
    ['dilutedShares', 'WeightedAverageNumberOfDilutedSharesOutstanding', 'shares']]) {
    facts['us-gaap'][tag] = { units: { [unit]: x.quarters.map(q => ({ start: q.start, end: q.end, filed: q.knownAt, val: q[key], form: '10-Q', accn: 'test-' + q.end })) } };
  }
  return { cik: 1, entityName: 'Fixture', sic: '3571', facts };
}
test('SEC adapter filters later restatements before resolving quarters', () => {
  const raw = rawFacts(); const points = raw.facts['us-gaap'].Revenues.units.USD;
  points.push({ ...points.at(-1), filed: '2025-05-01', val: 999 });
  const before = companyFactsModelInput(raw, '2025-02-01');
  assert.equal(before.quarters.at(-1).revenue, 165);
  assert.equal(companyFactsModelInput(raw, '2025-06-01').quarters.at(-1).revenue, 999);
  assert.ok(before.quarters.every(q => q.sources.every(s => s.filedAt <= '2025-02-01')));
  assert.throws(() => factsAsOf(raw, 'yesterday'));
});
test('Q4 diluted shares use weighted share-days rather than subtraction', () => {
  const raw = rawFacts(); const shares = raw.facts['us-gaap'].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares;
  shares.pop();
  shares.push({ start: '2024-01-01', end: '2024-09-30', filed: '2024-10-25', val: 10, form: '10-Q', accn: 'ytd' },
    { start: '2024-01-01', end: '2024-12-31', filed: '2025-01-25', val: 9.5, form: '10-K', accn: 'annual' });
  assert.equal(companyFactsModelInput(raw, '2025-02-01').quarters.at(-1).dilutedShares, (9.5 * 366 - 10 * 274) / 92);
});
test('backtest requires four realized consecutive quarters and does not invent folds', () => {
  assert.equal(backtestCompany(rawFacts(), '2025-02-01').folds.length, 0);
});

test('backtest runs realized folds and keeps future restatements out of predictions', () => {
  const raw = rawFacts();
  for (const c of Object.values(raw.facts['us-gaap'])) for (const points of Object.values(c.units)) {
    const old = [...points];
    for (const p of old) points.push({ ...p, start: p.start.replace('2023', '2025').replace('2024', '2026'),
      end: p.end.replace('2023', '2025').replace('2024', '2026'),
      filed: date(Number(p.filed.slice(0, 4)) + 2, Number(p.filed.slice(5, 7)) - 1, 25) });
  }
  const first = backtestCompany(raw, '2027-02-01');
  assert.ok(first.folds.length >= 4);
  assert.equal(first.folds[0].cutoff, '2025-01-25');
  const revenue = raw.facts['us-gaap'].Revenues.units.USD;
  revenue.push({ ...revenue[7], filed: '2026-05-01', val: 250 });
  const revised = backtestCompany(raw, '2027-02-01');
  assert.equal(revised.folds[0].revenue.predicted, first.folds[0].revenue.predicted);
});

test('calendar boundaries advance across leap years without drifting guidance', () => {
  const f = forecastFundamentals(input());
  assert.equal(f.period.end, '2025-12-31');
  assert.equal(f.period.datesEstimated, false);
  assert.deepEqual(f.scenarios.base.quarters.map(q => q.end), ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31']);
  assert.deepEqual(f.scenarios.base.quarters.map(q => q.start), ['2025-01-01', '2025-04-01', '2025-07-01', '2025-10-01']);
});


test('growth dampens expansions and contractions without changing eligibility thresholds', () => {
  const x = input();
  const f = forecastFundamentals(x);
  assert.ok(Math.abs(f.assumptions.historicalRevenueGrowth - .1) < 1e-12);
  assert.ok(Math.abs(f.assumptions.revenueGrowth - .05) < 1e-12);
  assert.equal(f.assumptions.growthDamping, .5);
  for (const q of x.quarters.slice(-4)) q.revenue *= .8 / 1.1;
  const down = forecastFundamentals(x);
  assert.ok(Math.abs(down.assumptions.revenueGrowth + .1) < 1e-12);
  const extreme = input(); extreme.quarters.at(-1).revenue *= 3;
  assert.equal(forecastFundamentals(extreme).reason, 'revenue-regime-change');
});

test('negative derived revenue is withheld with its original evidence', () => {
  const raw = rawFacts();
  const points = raw.facts['us-gaap'].Revenues.units.USD;
  points.pop();
  points.push({ start: '2024-01-01', end: '2024-09-30', filed: '2024-10-25', val: 500, form: '10-Q', accn: 'nine-month' },
    { start: '2024-01-01', end: '2024-12-31', filed: '2025-01-25', val: 450, form: '10-K', accn: 'annual' });
  const x = companyFactsModelInput(raw, '2025-02-01');
  assert.equal(x.quarters.at(-1).revenue, null);
  assert.equal(x.quarters.at(-1).revenueBasisIssue, true);
  assert.ok(x.quarters.at(-1).sources.some(s => s.accession === 'annual' && s.value === 450));
  assert.equal(forecastFundamentals(x).reason, 'inconsistent-revenue-basis');
});

test('loss outcomes remain in scaled earnings errors and exclusion counts reconcile', () => {
  const raw = rawFacts();
  for (const [tag, concept] of Object.entries(raw.facts['us-gaap'])) {
    for (const points of Object.values(concept.units)) {
      for (const p of [...points].slice(0, 4)) points.push({ ...p,
        start: p.start.replace('2023', '2025'), end: p.end.replace('2023', '2025'),
        filed: date(Number(p.filed.slice(0, 4)) + 2, Number(p.filed.slice(5, 7)) - 1, 25),
        val: tag === 'NetIncomeLoss' ? -10 : p.val });
    }
  }
  const result = backtestCompany(raw, '2026-02-01');
  assert.ok(result.folds.some(f => f.earnings.actual === -40));
  assert.ok(result.summary.earnings.includingLosses.nonpositiveOutcomes > 0);
  assert.ok(result.summary.earnings.includingLosses.observations > result.summary.earnings.observations);
  assert.ok(result.summary.earnings.includingLosses.meanAbsoluteErrorAsShareOfTrailingRevenue > 0);
  assert.equal(result.audit.cutoffs, Object.values(result.audit.withheld).reduce((a,b) => a+b, 0)
    + result.audit.duplicateHorizons + result.audit.incompleteOutcomes + result.folds.length);
  for (const p of raw.facts['us-gaap'].NetIncomeLoss.units.USD)
    if (p.start.startsWith('2025')) p.val = 0;
  const zero = backtestCompany(raw, '2026-02-01');
  const zeroFold = zero.folds.find(f => f.earnings.actual === 0);
  assert.ok(zeroFold);
  assert.equal(zeroFold.earnings.error, null);
  assert.equal(zeroFold.earnings.errorAsShareOfTrailingRevenue,
    Math.abs(zeroFold.earnings.predicted) / zeroFold.revenue.baseline);
  assert.equal(zeroFold.earnings.baselineErrorAsShareOfTrailingRevenue,
    Math.abs(zeroFold.earnings.baseline) / zeroFold.revenue.baseline);
  const unsupported = backtestCompany({ ...raw, sic: '6021' }, '2026-02-01');
  assert.equal(unsupported.audit.withheld['unsupported-basis'], unsupported.audit.cutoffs);
});

test('financial exclusion covers lenders, dealers, insurers and property lessors, not fee businesses', () => {
  // Banks, card lenders, broker-dealers, insurers (managed care included), REITs, blank checks.
  for (const sic of [6021, 6022, 6035, 6141, 6153, 6162, 6172, 6189, 6211, 6221, 6311, 6324, 6331, 6399,
    6510, 6512, 6513, 6770, 6798, 6799, 99, NaN]) assert.equal(unsupportedSic(sic), true, String(sic));
  // Finance services (crypto-mining and compute hosts, card networks), exchanges, asset managers,
  // insurance brokers, real-estate services and royalty owners keep the ordinary guards.
  for (const sic of [6199, 6200, 6282, 6411, 6500, 6531, 6552, 6792, 6794, 6795, 3571, 7374])
    assert.equal(unsupportedSic(sic), false, String(sic));
  const raw = rawFacts();
  assert.equal(companyFactsModelInput({ ...raw, sic: '6199' }, '2025-02-01').eligibility.unsupportedBusiness, false);
  assert.equal(companyFactsModelInput({ ...raw, sic: '6798' }, '2025-02-01').eligibility.unsupportedBusiness, true);
  assert.equal(companyFactsModelInput({ ...raw, sic: undefined }, '2025-02-01').eligibility.unsupportedBusiness, true);
  // A finance-services filer whose top line is net of interest expense is a lender by its own tags.
  raw.facts['us-gaap'].RevenuesNetOfInterestExpense = { units: { USD: [{ start: '2024-10-01', end: '2024-12-31',
    filed: '2025-01-25', val: 200, form: '10-K', accn: 'spread' }] } };
  assert.equal(companyFactsModelInput({ ...raw, sic: '6199' }, '2025-02-01').eligibility.unsupportedBusiness, true);
  assert.equal(companyFactsModelInput({ ...raw, sic: '6199' }, '2026-03-01').eligibility.unsupportedBusiness, false);
});

// Quarters tagged as contract revenue, the year re-filed under Revenues: the shape of a 10-K
// restated for a disposal after 10-Qs on the old tag. `closes` is the top line each cumulative
// filing's income statement starts from (costs plus operating income).
function retaggedYear({ closes = { nine: 385, annual: 550 }, staleAnnual = null } = {}) {
  const raw = rawFacts();
  const gaap = raw.facts['us-gaap'];
  const revenue = gaap.Revenues.units.USD;
  const year = revenue.splice(4, 4).slice(0, 3);
  const contract = year.map(p => ({ ...p }));
  contract.push({ start: '2024-01-01', end: '2024-09-30', filed: '2024-10-25', val: 385, form: '10-Q', accn: 'nine-month' });
  if (staleAnnual != null) contract.push({ start: '2024-01-01', end: '2024-12-31', filed: '2025-01-20', val: staleAnnual, form: '10-K', accn: 'old-annual' });
  gaap.RevenueFromContractWithCustomerExcludingAssessedTax = { units: { USD: contract } };
  revenue.push({ start: '2024-01-01', end: '2024-12-31', filed: '2025-01-25', val: 550, form: '10-K', accn: 'annual' });
  gaap.CostsAndExpenses = { units: { USD: [] } };
  for (const [accn, end, filed, form, top] of [['nine-month', '2024-09-30', '2024-10-25', '10-Q', closes.nine],
    ['annual', '2024-12-31', '2025-01-25', '10-K', closes.annual]]) {
    gaap.CostsAndExpenses.units.USD.push({ start: '2024-01-01', end, filed, form, accn, val: top * .75 });
    gaap.OperatingIncomeLoss.units.USD.push({ start: '2024-01-01', end, filed, form, accn, val: top * .25 });
  }
  return raw;
}

test('a year re-filed under another revenue tag differences against its own year to date', () => {
  const x = companyFactsModelInput(retaggedYear(), '2025-02-01');
  const q4 = x.quarters.at(-1);
  assert.deepEqual([q4.start, q4.end, q4.revenue], ['2024-10-01', '2024-12-31', 165]);
  assert.deepEqual(q4.sources.filter(s => s.concept !== 'NetIncomeLoss' && /Revenue/.test(s.concept)).map(s => [s.concept, s.value]).sort(),
    [['RevenueFromContractWithCustomerExcludingAssessedTax', 385], ['Revenues', 550]]);
  assert.equal(forecastFundamentals(x).status, 'estimated');
  assert.equal(x.quarters.at(-1).revenueReconciled, true);
  // Nine months of contract revenue that leaves out 75 of rent: its own filing's income statement
  // starts from 460, so it is not differenced against the annual total.
  const partial = companyFactsModelInput(retaggedYear({ closes: { nine: 460, annual: 550 } }), '2025-02-01');
  assert.equal(partial.quarters.at(-1).end, '2024-09-30');
  assert.equal(forecastFundamentals(partial).reason, 'insufficient-history');
});

test('a negative quarter from a stale annual takes the current annual of the same basis', () => {
  const x = companyFactsModelInput(retaggedYear({ staleAnnual: 300 }), '2025-02-01');
  assert.equal(x.quarters.at(-1).revenue, 165);
  assert.equal(x.quarters.at(-1).revenueBasisIssue, undefined);
  assert.ok(!x.quarters.at(-1).sources.some(s => s.accession === 'old-annual'));
  // The stale figure alone, with no current-basis annual, stays an input-basis error.
  const raw = retaggedYear({ staleAnnual: 300 });
  raw.facts['us-gaap'].Revenues.units.USD.pop();
  const stale = companyFactsModelInput(raw, '2025-02-01');
  assert.equal(stale.quarters.at(-1).revenueBasisIssue, true);
  assert.equal(forecastFundamentals(stale).reason, 'inconsistent-revenue-basis');
});

test('a share count that jumps between adjacent quarters withholds P/E even when each year repeats it', () => {
  const x = input();
  for (const q of x.quarters) if (q.end.endsWith('-12-31')) q.dilutedShares = 30;
  const f = forecastFundamentals(x);
  assert.equal(f.status, 'estimated');
  assert.equal(f.earningsReason, 'share-basis-discontinuity');
  assert.equal(f.scenarios.base.eps, null);
  const steady = input(); steady.quarters.forEach((q, i) => { q.dilutedShares = 10 * 1.02 ** i; });
  assert.equal(forecastFundamentals(steady).earningsReason, null);
});


// TeraWulf's 10-Q for the quarter ended September 30, 2026 (accession 0001628280-26-071671):
// net income available to common shareholders 709,912,000 (basic EPS 1.42 on 500,068,776
// shares); diluted EPS removes a 728,442,000 warrant fair-value gain, leaving -18,530,000 over
// 573,606,743 diluted shares (EPS -0.03). The fixture keeps its own dates; the figures are WULF's.
const lastPoint = (raw, tag) => { const ps = Object.values(raw.facts['us-gaap'][tag].units)[0]; return ps[ps.length - 1]; };
const filedLike = (raw, val) => { const p = { ...lastPoint(raw, 'NetIncomeLoss') }; p.val = val; return p; };
test('the SEC adapter divides the diluted-EPS numerator, not basic earnings, by diluted shares', () => {
  const raw = rawFacts(); const g = raw.facts['us-gaap'];
  lastPoint(raw, 'NetIncomeLoss').val = 709_912_000;
  lastPoint(raw, 'WeightedAverageNumberOfDilutedSharesOutstanding').val = 573_606_743;
  g.NetIncomeLossAvailableToCommonStockholdersDiluted = { units: { USD: [filedLike(raw, -18_530_000)] } };
  g.EarningsPerShareDiluted = { units: { 'USD/shares': [filedLike(raw, -0.03)] } };
  const input = companyFactsModelInput(raw, '2025-02-01'); const q = input.quarters.at(-1);
  assert.equal(q.basicNetIncome - q.netIncome, 728_442_000);
  assert.equal(q.earningsNumerator, 'diluted');
  assert.equal(Math.round(q.netIncome / q.dilutedShares * 100) / 100, q.reportedDilutedEPS);
  assert.equal(Math.round(q.basicNetIncome / q.dilutedShares * 100) / 100, 1.24);
  assert.ok(q.sources.some((s) => s.concept === 'EarningsPerShareDiluted'));
  const f = forecastFundamentals(input);
  assert.equal(f.earningsReason, 'nonpositive-earnings');
  assert.equal(f.scenarios.base.eps, null);
  // Untagged, on the fixture's own scale with WULF's diluted-to-basic ratio: the reported diluted
  // EPS still exposes the basic numerator, though every earlier guard passes.
  const plain = rawFacts(); const basic = lastPoint(plain, 'NetIncomeLoss').val;
  plain.facts['us-gaap'].EarningsPerShareDiluted = { units: { 'USD/shares': [filedLike(plain,
    Math.round(basic * -18_530_000 / 709_912_000 / 10 * 100) / 100)] } };
  assert.equal(forecastFundamentals(companyFactsModelInput(rawFacts(), '2025-02-01')).earningsReason, null);
  const untagged = companyFactsModelInput(plain, '2025-02-01');
  assert.equal(untagged.quarters.at(-1).earningsNumerator, 'basic');
  assert.equal(forecastFundamentals(untagged).earningsReason, 'diluted-earnings-basis');
});
test('a warrant gain filed with its diluted numerator stays out of forward EPS', () => {
  const withGain = (share) => {
    const raw = rawFacts(); const g = raw.facts['us-gaap'];
    const net = lastPoint(raw, 'NetIncomeLoss'); const gain = lastPoint(raw, 'Revenues').val * share;
    g.NetIncomeLossAvailableToCommonStockholdersDiluted = { units: { USD: [filedLike(raw, net.val)] } };
    g.EarningsPerShareDiluted = { units: { 'USD/shares': g.NetIncomeLoss.units.USD.map((p) => ({ ...p, val: Math.round(p.val / 10 * 100) / 100 })) } };
    net.val += gain;
    lastPoint(raw, 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest').val += gain;
    return companyFactsModelInput(raw, '2025-02-01');
  };
  const small = withGain(0.02); const q = small.quarters.at(-1);
  assert.equal(q.earningsNumerator, 'diluted'); assert.ok(q.basicNetIncome > q.netIncome);
  const f = forecastFundamentals(small);
  assert.equal(f.earningsReason, null);
  // On the basic numerator (version 3) the gain enters trailing EPS; median projection drops a
  // one-off either way, so the forward bias comes from adjustments that recur every quarter.
  const basicBasis = { ...small, quarters: small.quarters.map((x) => ({ ...x, netIncome: x.basicNetIncome,
    earningsNumerator: undefined, reportedDilutedEPS: null })) };
  const v3 = forecastFundamentals(basicBasis);
  assert.ok(Math.abs(v3.baselines.eps - f.baselines.eps - (q.basicNetIncome - q.netIncome) / 10) < 1e-9);
  assert.ok(Math.abs(v3.scenarios.base.eps - f.scenarios.base.eps) < 1e-9);
  assert.equal(forecastFundamentals(withGain(0.1)).earningsReason, 'common-earnings-reconciliation');
});
test('the reported-EPS check holds at half a cent plus 5%, in both directions and in any recent quarter', () => {
  const at = (ratio, i = 7, shares = 10) => { const x = input(); x.quarters.forEach((q) => { q.dilutedShares = shares; });
    const q = x.quarters[i]; q.reportedDilutedEPS = q.netIncome / shares * ratio; return forecastFundamentals(x).earningsReason; };
  assert.equal(at(1 / 1.04), null); assert.equal(at(1 / 1.06), 'diluted-earnings-basis');
  assert.equal(at(1.04), null); assert.equal(at(1.06), 'diluted-earnings-basis');
  assert.equal(at(1 / 1.06, 4), 'diluted-earnings-basis');
  assert.equal(at(1 / 1.06, 3), null);
  // At three cents a share, cent rounding (0.0317 reported as 0.03) is within the half-cent floor.
  assert.ok(matchesReportedEps(31.68, 1000, 0.03)); assert.ok(!matchesReportedEps(31.68, 1000, 0.02));
  assert.equal(at(0.03 / 0.03168, 7, 1000), null);
});
test('exchangeable units use the diluted numerator; a basic quarter with nothing to check it withholds P/E', () => {
  const units = (ratio = 0.77) => { const x = input(); for (const q of x.quarters) {
    q.basicNetIncome = q.netIncome * ratio; q.earningsNumerator = 'diluted';
    q.pretaxIncome = q.netIncome + q.tax; q.reportedDilutedEPS = q.netIncome / q.dilutedShares; } return x; };
  const consistent = forecastFundamentals(units());
  assert.equal(consistent.earningsReason, null);
  assert.ok(Math.abs(consistent.baselines.eps - units().quarters.slice(-4).reduce((a, q) => a + q.netIncome / 10, 0)) < 1e-9);
  const unchecked = units(); Object.assign(unchecked.quarters.at(-1), { earningsNumerator: 'basic', reportedDilutedEPS: null });
  assert.equal(forecastFundamentals(unchecked).earningsReason, 'diluted-earnings-basis');
  const checked = units(); Object.assign(checked.quarters.at(-1), { earningsNumerator: 'basic' });
  assert.equal(forecastFundamentals(checked).earningsReason, null);
  const slight = units(0.96); Object.assign(slight.quarters.at(-1), { earningsNumerator: 'basic', reportedDilutedEPS: null });
  assert.equal(forecastFundamentals(slight).earningsReason, null);
  const dilutedNoEps = units(); dilutedNoEps.quarters.at(-1).reportedDilutedEPS = null;
  assert.equal(forecastFundamentals(dilutedNoEps).earningsReason, null);
});
test('the adapter trusts a diluted numerator only when filed for the quarter and consistent with its EPS', () => {
  // A fourth quarter differenced from a year and nine months is not the quarter's diluted numerator.
  const derived = rawFacts(); const net = lastPoint(derived, 'NetIncomeLoss').val;
  derived.facts['us-gaap'].NetIncomeLossAvailableToCommonStockholdersDiluted = { units: { USD: [
    { start: '2024-01-01', end: '2024-09-30', filed: '2024-10-25', val: 400, form: '10-Q', accn: 'ytd' },
    { start: '2024-01-01', end: '2024-12-31', filed: '2025-01-25', val: 400 + net * 1.2, form: '10-K', accn: 'annual' }] } };
  assert.equal(companyFactsModelInput(derived, '2025-02-01').quarters.at(-1).earningsNumerator, 'basic');
  // The adjustment tagged as the numerator: the reported EPS selects basic earnings instead.
  const adjustment = rawFacts(); const a = adjustment.facts['us-gaap'];
  a.NetIncomeLossAvailableToCommonStockholdersDiluted = { units: { USD: [filedLike(adjustment, -4.7)] } };
  a.EarningsPerShareDiluted = { units: { 'USD/shares': [filedLike(adjustment, Math.round(net / 10 * 100) / 100)] } };
  const qa = companyFactsModelInput(adjustment, '2025-02-01').quarters.at(-1);
  assert.equal(qa.earningsNumerator, 'basic'); assert.equal(qa.netIncome, net);
  // A sign-flipped figure with no EPS to confirm it is not trusted; a plausible one is.
  for (const [val, basis] of [[-net, 'basic'], [net * 1.6, 'basic'], [net * 1.2, 'diluted']]) {
    const raw = rawFacts();
    raw.facts['us-gaap'].NetIncomeLossAttributableToParentDiluted = { units: { USD: [filedLike(raw, val)] } };
    assert.equal(companyFactsModelInput(raw, '2025-02-01').quarters.at(-1).earningsNumerator, basis);
  }
});
test('reported EPS comes from the share count filing and never dates the quarter', () => {
  const raw = rawFacts(); const net = lastPoint(raw, 'NetIncomeLoss').val;
  const own = Math.round(net / 10 * 100) / 100;
  raw.facts['us-gaap'].EarningsPerShareDiluted = { units: { 'USD/shares': [filedLike(raw, own),
    { ...filedLike(raw, own / 6), filed: '2025-01-30', accn: 'post-split' }] } };
  const q = companyFactsModelInput(raw, '2025-02-01').quarters.at(-1);
  assert.equal(q.reportedDilutedEPS, own);
  assert.equal(q.knownAt, companyFactsModelInput(rawFacts(), '2025-02-01').quarters.at(-1).knownAt);
  const later = rawFacts();
  later.facts['us-gaap'].EarningsPerShareDiluted = { units: { 'USD/shares': [{ ...filedLike(later, own), filed: '2025-01-30', accn: 'later' }] } };
  assert.equal(companyFactsModelInput(later, '2025-02-01').quarters.at(-1).knownAt, q.knownAt);
});
