import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastFundamentals, priceForwardForecast } from '../docs/core/forward-valuation-model.js';
import { companyFactsModelInput, factsAsOf } from '../scripts/forward-valuation-inputs.mjs';
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
