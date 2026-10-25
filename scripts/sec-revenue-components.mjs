// Which revenue candidate concepts are only a part of this filer's revenue (issue #5707,
// prd/fundamentals/total-revenue.md).
//
// The revenue resolvers take candidates freshest first, then in list order. Two kinds of candidate
// are often a part of revenue rather than the total: contract revenue (ASC 606, which leaves out
// lease income, premiums and interest) and operating lease income. When a filer tags one of them
// beside its total for the same period, list order picked the part: Copart's revenue read as $17.1M
// of lease income beside $4.67B under RevenueFromContractWithCustomerIncludingAssessedTax, and UDR's
// as $11.4M of contract revenue beside $1.71B of Revenues. The filer's own facts say which is which,
// so the decision is per filer and read from them.

const key = (ns, tag) => `${ns}:${tag}`;

// A total is broader than contract revenue and lease income; contract revenue is broader than lease
// income. Totals are never compared with each other, and neither are the two contract tags: the
// Including and Excluding figures differ by excise tax (Brown-Forman's 5,082 gross against 3,928 of
// net sales), not by a business line.
const TOTALS = new Set([
  key('us-gaap', 'Revenues'),
  key('us-gaap', 'RevenuesNetOfInterestExpense'),
  key('us-gaap', 'RegulatedAndUnregulatedOperatingRevenue'),
  key('us-gaap', 'SalesRevenueNet'),
  key('ifrs-full', 'Revenue'),
]);
const CONTRACT = new Set([
  key('us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'),
  key('us-gaap', 'RevenueFromContractWithCustomerIncludingAssessedTax'),
  key('ifrs-full', 'RevenueFromContractsWithCustomers'),
]);
const LEASE = new Set([key('us-gaap', 'OperatingLeaseLeaseIncome')]);

// How `other` can show `component` to be partial: 'any' by size or by a confirmed identity, 'size'
// by size alone, null not at all. A lessor with no total tag (Camden: 13M of contract revenue beside
// 1,574M of lease income) has its contract revenue judged against the lease income by size; the
// identities below never confirm lease income as a total, so size is the only evidence there.
function comparison(component, other) {
  if (CONTRACT.has(component)) return TOTALS.has(other) ? 'any' : LEASE.has(other) ? 'size' : null;
  if (LEASE.has(component)) return TOTALS.has(other) || CONTRACT.has(other) ? 'any' : null;
  return null;
}

// A part this much smaller than a broader figure for the same period is a missing business line, not
// a classification difference. Among filers whose smaller figure is the reported top line, the widest
// gap measured is Republic Services, whose Revenues (19,027) is gross revenue before intercompany
// eliminations against 16,591 reported: 87%.
const PARTIAL_SHARE = 0.8;
// Identities hold to the filer's rounding; 0.1% of the figure leaves room for that and no more.
const IDENTITY_TOLERANCE = 0.001;
// The comparison has to describe how the filer reports now. A pair last seen together at the 2018
// change of standard says nothing about a concept the filer still uses.
const RECENCY_DAYS = 400;
const PROXY_STATEMENT_FORMS = /14A|14C/;
const MIN_DAYS = 60;
const MAX_DAYS = 400;
const ANNUAL_MIN_DAYS = 330;

const COST_OF_REVENUE = ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfServices', 'CostOfGoodsSold'];
const TOTAL_COSTS = ['CostsAndExpenses', 'OperatingCostsAndExpenses', 'BenefitsLossesAndExpenses', 'OperatingExpenses'];

function days(start, end) {
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? ms / 86_400_000 : null;
}

// One value per (unit, start, end), the latest filing winning, as the resolvers dedupe.
function periodValues(facts, ns, tag) {
  const out = new Map();
  for (const [unit, points] of Object.entries(facts?.[ns]?.[tag]?.units || {})) {
    if (!Array.isArray(points)) continue;
    for (const point of points) {
      if (!point?.start || !point?.end || PROXY_STATEMENT_FORMS.test(String(point.form || ''))) continue;
      const val = Number(point.val);
      const span = days(point.start, point.end);
      if (!Number.isFinite(val) || span == null || span < MIN_DAYS || span > MAX_DAYS) continue;
      const id = `${unit}|${point.start}|${point.end}`;
      const prior = out.get(id);
      if (!prior || String(point.filed || '') > String(prior.filed || '')) {
        out.set(id, { unit, start: point.start, end: point.end, val, filed: point.filed || '' });
      }
    }
  }
  return out;
}

// One filer's us-gaap figure for a period, each concept indexed once per filer.
function usGaapReader(facts) {
  const indexed = new Map();
  return (tag, id) => {
    if (!indexed.has(tag)) indexed.set(tag, periodValues(facts, 'us-gaap', tag));
    return indexed.get(tag).get(id)?.val ?? null;
  };
}
const near = (value, target) => Math.abs(value - target) <= Math.abs(target) * IDENTITY_TOLERANCE;

// The figure the income statement's own arithmetic starts from: less cost of revenue it gives the
// filed gross profit, or less total costs the filed operating income. A figure that is a part of
// revenue does not close either.
function closesIncomeStatement(at, value, id) {
  const grossProfit = at('GrossProfit', id);
  if (grossProfit != null && COST_OF_REVENUE.some((tag) => {
    const cost = at(tag, id);
    return cost != null && near(value - cost, grossProfit);
  })) return true;
  const operatingIncome = at('OperatingIncomeLoss', id);
  return operatingIncome != null && TOTAL_COSTS.some((tag) => {
    const costs = at(tag, id);
    return costs != null && near(value - costs, operatingIncome);
  });
}

// A total equal to contract revenue plus the revenue outside contracts (or plus lease income), each
// filed for the same period, is the sum of its parts by the filer's own tags.
// An addend within the tolerance of zero proves nothing: Dollar Tree files 0.0 of revenue outside
// contracts for FY2020, and contract revenue plus zero would confirm any figure equal to it.
function sumOfParts(at, value, id) {
  const contract = [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
  ].map((tag) => at(tag, id)).filter((v) => v != null);
  const others = ['RevenueNotFromContractWithCustomer', 'OperatingLeaseLeaseIncome']
    .map((tag) => at(tag, id)).filter((v) => v != null && !near(v, 0) && Math.abs(v) > Math.abs(value) * IDENTITY_TOLERANCE);
  return contract.some((part) => others.some((other) => near(part + other, value)));
}

// The period the comparison reads: the latest fiscal year both concepts report, in one unit, when it
// is current; otherwise the latest shared period of any length, the longer on a tie. A fiscal year
// first because it is the figure the filer reports as its year: Welltower's contract revenue is 78%
// of Revenues for FY2025 and 83% for the quarter after it.
function sharedPeriod(left, right, newest) {
  let annual = null;
  let any = null;
  const later = (point, best) => !best || point.end > best.point.end
    || (point.end === best.point.end && days(point.start, point.end) > days(best.point.start, best.point.end));
  for (const [id, point] of left) {
    if (!right.has(id)) continue;
    if (later(point, any)) any = { id, point };
    if (days(point.start, point.end) >= ANNUAL_MIN_DAYS && later(point, annual)) annual = { id, point };
  }
  return annual && days(annual.point.end, newest) <= RECENCY_DAYS ? annual : any;
}

// The candidates (as `ns:tag`) whose own filings show them to be a part of this filer's revenue.
export function partialRevenueConcepts(facts, candidates) {
  const present = candidates
    .map(([ns, tag]) => ({ ns, tag, id: key(ns, tag), values: periodValues(facts, ns, tag) }))
    .filter((candidate) => candidate.values.size);
  const at = usGaapReader(facts);
  const partial = new Set();
  for (const component of present) {
    const newest = [...component.values.values()].reduce((max, point) => (point.end > max ? point.end : max), '');
    for (const broader of present) {
      const evidence = comparison(component.id, broader.id);
      if (!evidence) continue;
      const shared = sharedPeriod(component.values, broader.values, newest);
      if (!shared || days(shared.point.end, newest) > RECENCY_DAYS) continue;
      const part = shared.point.val;
      const whole = broader.values.get(shared.id).val;
      if (!(whole > part)) continue;
      // A part that closes the income statement is the top line, whatever else is larger (Hasbro's
      // Revenues is 5,366 against reported net revenues of 4,701).
      if (component.ns === 'us-gaap' && closesIncomeStatement(at, part, shared.id)) continue;
      // The sum of parts confirms a total only: contract revenue is one of its own addends.
      const confirmed = evidence === 'any' && broader.ns === 'us-gaap'
        && (closesIncomeStatement(at, whole, shared.id) || (TOTALS.has(broader.id) && sumOfParts(at, whole, shared.id)));
      if (part < whole * PARTIAL_SHARE || confirmed) {
        partial.add(component.id);
        break;
      }
    }
  }
  return partial;
}

// The candidate list with the partial concepts moved last, in their own order, each marked
// `fillsGapsOnly`. Last makes them lose every tie on freshness; the mark tells the annual and
// quarterly resolvers to let them supply only a period no other candidate reports. Not dropped: the
// same tag can be the whole of revenue in years before the filer had revenue outside it
// (MercadoLibre's contract revenue was its total until its credit income began in 2021).
export function withPartialRevenueLast(candidates, partial) {
  if (!partial.size) return candidates;
  const isPartial = ([ns, tag]) => partial.has(key(ns, tag));
  return [
    ...candidates.filter((candidate) => !isPartial(candidate)),
    ...candidates.filter(isPartial).map((candidate) => Object.freeze(Object.assign([...candidate], { fillsGapsOnly: true }))),
  ];
}
