// SEC adapter for the research model. Filter publication dates BEFORE selecting/reconstructing quarters.
import { operatingQuarterSeries } from './sec-operating-quarters.mjs';
import { partialRevenueConcepts, withPartialRevenueLast } from './sec-revenue-components.mjs';
import { daysBetween, validDate } from '../docs/core/forward-valuation-model.js';
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

export function companyFactsModelInput(raw, asOf) {
  const facts = factsAsOf(raw, asOf);
  const revenueTags = withPartialRevenueLast(REVENUE, partialRevenueConcepts(facts, REVENUE));
  const resolve = (candidates) => operatingQuarterSeries(facts, candidates, 'USD', { depth: 100 });
  const series = Object.fromEntries(Object.entries(METRICS).map(([key, cs]) => [key, resolve(cs)]));
  const revenues = resolve(revenueTags);
  const quarters = revenues.map((r) => {
    const sources = [...origins(r)];
    const row = { start: r.start, end: r.end, currency: 'USD', revenue: r.val };
    for (const [key, points] of Object.entries(series)) {
      const p = points.find((p) => p.start === r.start && p.end === r.end);
      row[key] = p?.val ?? null;
      sources.push(...origins(p));
    }
    const shares = sharesFor(facts, r);
    row.dilutedShares = shares?.value ?? null;
    sources.push(...(shares?.sources || []));
    row.sources = sources;
    row.knownAt = sources.map((s) => s.filedAt).sort().at(-1);
    return row;
  });
  const sic = Number(raw.sic);
  return { asOf, currency: 'USD', quarters, eligibility: {
    unsupportedBusiness: !facts['us-gaap'] || !Number.isInteger(sic) || sic < 100 || (sic >= 6000 && sic < 6800),
    shareBasisUnresolved: raw.shareBasisUnresolved === true,
  }, provenance: { cik: raw.cik, name: raw.entityName,
    source: `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(raw.cik).padStart(10, '0')}.json`,
    limitation: 'SEC publication-date reconstruction, not a replay of original ingestion. Calendar and share-basis eligibility require verification.' } };
}
