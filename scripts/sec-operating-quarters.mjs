// Discrete operating periods for display, independent of the TTM valuation event series.
// Subtract cumulative flows only within the same concept, currency, and fiscal-year start.
const DAY = 86400000;
const days = (start, end) => (Date.parse(end) - Date.parse(start)) / DAY;
const nextDay = (end) => new Date(Date.parse(end) + DAY).toISOString().slice(0, 10);
const quarterLength = (start, end) => days(start, end) >= 70 && days(start, end) <= 110;

// The evidence for one filed point, in the shape the fact store reads (scripts/sec-fundamentals-lib.mjs
// pointOrigin, prd/fact-store.md "Quarterly facts"). Carried on the point, so it follows the value
// through every re-key and derivation below.
function filedOrigin(ns, tag, p, unit) {
  return Object.freeze({
    kind: 'filed',
    accession: p.accn || null,
    filedAt: p.filed || null,
    form: p.form || null,
    taxonomy: ns,
    concept: tag,
    unit,
    start: p.start,
    end: p.end,
    value: p.val,
  });
}

// A computed quarter's evidence: every input with its signed coefficient. An input that is itself
// derived is expanded into the filed points under it, coefficients multiplied through, so every
// component a caller walks down to has a filing of its own.
function termsOf(point, coefficient) {
  const origin = point.origin;
  if (!origin) return null;
  if (origin.kind === 'filed') return [{ origin, coefficient }];
  return origin.terms.map((term) => ({ origin: term.origin, coefficient: term.coefficient * coefficient }));
}

// The same filed point reached twice (Q4 as the year minus three quarters, where Q2 was itself the
// half-year minus Q1, reaches Q1 once added and once subtracted) is one term with the coefficients
// summed, and a term that cancels to zero is dropped: it contributes nothing, and listing it would
// name a filing the value does not depend on.
const originKey = (origin) => [
  origin.taxonomy, origin.concept, origin.unit, origin.start, origin.end, origin.accession, origin.value,
].join('|');

function derivedFrom(method, inputs) {
  const byOrigin = new Map();
  for (const [point, coefficient] of inputs) {
    const expanded = termsOf(point, coefficient);
    if (!expanded) return null;
    for (const term of expanded) {
      const key = originKey(term.origin);
      const prior = byOrigin.get(key);
      byOrigin.set(key, { origin: term.origin, coefficient: (prior?.coefficient || 0) + term.coefficient });
    }
  }
  const terms = [...byOrigin.values()].filter((term) => term.coefficient !== 0);
  if (!terms.length) return null;
  return Object.freeze({ kind: 'derived', method, terms: Object.freeze(terms.map(Object.freeze)) });
}

// `depth` is how many of the newest quarters to keep. The chart path keeps sixteen, as it always
// has; the fact store asks for forty, ten fiscal years.
export function operatingQuarterSeries(facts, candidates, unit, { depth = 16 } = {}) {
  const histories = candidates.map((candidate, preference) => {
    const [ns, tag] = candidate;
    const byPeriod = new Map();
    for (const p of facts[ns]?.[tag]?.units?.[unit] || []) {
      if (!Number.isFinite(p.val) || !/^\d{4}-\d{2}-\d{2}$/.test(p.start || '')
        || !/^\d{4}-\d{2}-\d{2}$/.test(p.end || '')
        || !/^(10-Q|10-K|20-F|40-F)(\/A)?$/.test(p.form || '')
        || days(p.start, p.end) < 70 || days(p.start, p.end) > 380) continue;
      const key = `${p.start}/${p.end}`;
      if (String(p.filed || '') >= String(byPeriod.get(key)?.filed || '')) {
        byPeriod.set(key, { ...p, unit, origin: filedOrigin(ns, tag, p, unit) });
      }
    }
    const points = [...byPeriod.values()];
    const quarters = points.filter((p) => quarterLength(p.start, p.end));
    for (const p of points.filter((point) => days(point.start, point.end) >= 160)) {
      const prior = points.filter((q) => q.start === p.start && q.end < p.end
        && quarterLength(nextDay(q.end), p.end)).sort((a, b) => b.end.localeCompare(a.end))[0];
      if (prior && !quarters.some((q) => q.end === p.end)) {
        quarters.push({
          ...p, start: nextDay(prior.end), val: p.val - prior.val, derived: 'ytd-difference',
          origin: derivedFrom('ytd-difference', [[p, 1], [prior, -1]]),
        });
      }
    }
    // A 10-Q can carry a six-month total and its own three-month quarter while no filing carries
    // the first quarter on its own (META's interest expense, whose Q1 appears only inside the
    // half-year). The first quarter then resolves as the six-month total minus that quarter, under
    // the same concept, currency, and fiscal-year start as the year-to-date differences above.
    for (const p of points.filter((point) => days(point.start, point.end) >= 160 && days(point.start, point.end) <= 200)) {
      const second = quarters.find((q) => q.end === p.end && q.start > p.start && !q.derived);
      if (!second) continue;
      const firstEnd = new Date(Date.parse(second.start) - DAY).toISOString().slice(0, 10);
      // Any filed quarter starting with the half-year stands, even one whose end is tagged a day
      // off: a second, overlapping first quarter would break the Q4 step's three-quarter check.
      if (!quarterLength(p.start, firstEnd) || quarters.some((q) => q.start === p.start)) continue;
      quarters.push({
        ...p, end: firstEnd, val: p.val - second.val, derived: 'half-minus-second-quarter',
        origin: derivedFrom('half-minus-second-quarter', [[p, 1], [second, -1]]),
      });
    }
    // Some 10-Ks omit a nine-month cash-flow context. Q4 still resolves from an exact
    // year covered by three adjacent discrete quarters, never from an annual average.
    for (const annual of points.filter((p) => days(p.start, p.end) >= 350)) {
      if (quarters.some((q) => q.end === annual.end)) continue;
      const inner = quarters.filter((q) => q.start >= annual.start && q.end < annual.end)
        .sort((a, b) => a.start.localeCompare(b.start));
      if (inner.length !== 3 || inner[0].start !== annual.start
        || inner.slice(1).some((q, i) => q.start !== nextDay(inner[i].end))
        || !quarterLength(nextDay(inner[2].end), annual.end)) continue;
      quarters.push({ ...annual, start: nextDay(inner[2].end),
        val: annual.val - inner.reduce((sum, q) => sum + q.val, 0), derived: 'annual-minus-three-quarters',
        origin: derivedFrom('annual-minus-three-quarters', [[annual, 1], ...inner.map((q) => [q, -1])]) });
    }
    return { quarters, preference, latest: quarters.map((p) => p.end).sort().at(-1) || '', fillsGapsOnly: Boolean(candidate.fillsGapsOnly) };
  }).sort((a, b) => b.latest.localeCompare(a.latest) || a.preference - b.preference);
  const byPeriod = new Map();
  // A concept marked as a part of revenue (scripts/sec-revenue-components.mjs) only supplies a
  // quarter no other candidate reports, however fresh it is and however the others derived theirs.
  // Within each tier, two passes, so a first quarter derived from a half-year under a preferred tag
  // never displaces one another tag actually filed for the same period: the derivation only fills gaps.
  for (const tier of [false, true]) {
    for (const pass of [(q) => q.derived !== 'half-minus-second-quarter', (q) => q.derived === 'half-minus-second-quarter']) {
      for (const { quarters } of histories.filter((history) => history.fillsGapsOnly === tier)) {
        for (const q of quarters.filter(pass)) {
          const key = `${q.start}/${q.end}`;
          if (!byPeriod.has(key)) byPeriod.set(key, q);
        }
      }
    }
  }
  return [...byPeriod.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-depth);
}

// Fiscal labels come from actual annual boundaries, including 52/53-week calendars.
// Do not use a comparative fact's `fy`: that is the filing year, not its observation year.
export function operatingQuarterLabel(point, annuals) {
  let anchor = annuals.find((a) => point.start >= a.start && point.end <= a.end);
  let year = anchor?.end?.slice(0, 4);
  if (!anchor) {
    const prior = annuals.filter((a) => a.end < point.start).at(-1);
    if (!prior || days(prior.end, point.end) > 380) return null;
    anchor = { start: nextDay(prior.end) };
    year = Number(prior.end.slice(0, 4)) + 1;
  }
  const q = Math.round((days(anchor.start, point.end) + 1) / 91.25);
  if (q < 1 || q > 4 || Math.abs(days(anchor.start, point.start) - (q - 1) * 91.25) > 20) return null;
  return `Q${q}'${String(year).slice(-2)}`;
}

// Revenue below zero is not a quarter's sales but two vintages of one year: Crown Castle's FY2023,
// re-filed after its fiber business moved to discontinued operations (4,734M), less its nine months
// as first filed (5,307M) derived a fourth quarter of -573M. A derived revenue quarter below zero is
// left out of the fact store and shown without revenue; a filed one stands, as filed.
function withoutNegativeDerivedRevenue(series) {
  if (!series.revenue) return series;
  return { ...series, revenue: series.revenue.filter((p) => !(p.derived && p.val < 0)) };
}

// A decreasing cumulative capex series is inconsistent for this cash-outflow tag.
// Reject that fiscal year's derived capex rather than publishing negative spending
// or overstating FCF (ALAB's 2024 six-month XBRL context is one such case).
function withoutInvalidCapexYears(series, annuals) {
  if (!series.capex) return series;
  const invalidCapexYears = new Set(series.capex.filter((p) => p.val < 0)
    .map((p) => operatingQuarterLabel(p, annuals)?.split("'")[1]).filter(Boolean));
  return {
    ...series,
    capex: series.capex.filter((p) => !invalidCapexYears.has(operatingQuarterLabel(p, annuals)?.split("'")[1])),
  };
}

export function assembleOperatingQuarters(facts, annual, concepts, annuals) {
  if (!annual?.unit) return null;
  const series = withoutInvalidCapexYears(Object.fromEntries(Object.entries(concepts).map(([key, candidates]) => [
    key, operatingQuarterSeries(facts, candidates, annual.unit),
  ])), annuals);
  const revenue = series.revenue.filter((p) => operatingQuarterLabel(p, annuals));
  if (!revenue.length || revenue.at(-1).end < annual.ends.at(-1)) return null;
  // Use a contiguous tail so period comparisons cannot step over a missing quarter.
  let start = revenue.length - 1;
  while (start > 0 && nextDay(revenue[start - 1].end) === revenue[start].start) start--;
  const points = revenue.slice(Math.max(start, revenue.length - 12));
  const result = {
    unit: annual.unit,
    periods: points.map((p) => operatingQuarterLabel(p, annuals)),
    starts: points.map((p) => p.start),
    ends: points.map((p) => p.end),
  };
  // The quarter keeps its place in the run, so its neighbours still compare across it, with no
  // revenue (withoutNegativeDerivedRevenue).
  const kept = new Set(withoutNegativeDerivedRevenue(series).revenue.map((p) => `${p.start}/${p.end}`));
  for (const [key, values] of Object.entries(series)) {
    const byPeriod = new Map(values.map((p) => [`${p.start}/${p.end}`, p.val]));
    result[key] = points.map((p) => (key === 'revenue' && !kept.has(`${p.start}/${p.end}`)
      ? null : byPeriod.get(`${p.start}/${p.end}`) ?? null));
  }
  return result;
}

// The quarters the fact store keeps (prd/fact-store.md, "Quarterly facts"): the same resolution the
// charts use, so the two can never disagree about a quarter, taken forty quarters deep. Each metric
// keeps only quarters that sit on the filer's fiscal calendar and carry their evidence. Unlike the
// chart path this does not require a contiguous tail: a quarter with a filing behind it is a fact
// whether or not its neighbour resolved.
export const QUARTERLY_FACT_DEPTH = 40;

export function quarterlyFactSeries(facts, annual, concepts, annuals) {
  if (!annual?.unit) return null;
  const series = withoutNegativeDerivedRevenue(withoutInvalidCapexYears(Object.fromEntries(Object.entries(concepts).map(([key, candidates]) => [
    key, operatingQuarterSeries(facts, candidates, annual.unit, { depth: QUARTERLY_FACT_DEPTH }),
  ])), annuals));
  const quarters = Object.fromEntries(Object.entries(series).map(([key, points]) => [
    key,
    points
      .filter((p) => p.origin && operatingQuarterLabel(p, annuals))
      .map((p) => ({ start: p.start, end: p.end, value: p.val, origin: p.origin })),
  ]));
  return Object.values(quarters).some((points) => points.length) ? { unit: annual.unit, quarters } : null;
}

// Fiscal years for a filer with no annual report yet, read from its 10-Qs (prd/fundamentals.md,
// "Quarterly cards before the first annual report", issue #4173). Every 10-Q states its year to
// date, which starts on the first day of the fiscal year, and a comparative column a year earlier,
// which starts on the first day of the year before. Each start opens a twelve-month window, the
// shape `operatingQuarterLabel` reads annual reports as. Starts less than about a year apart
// contradict each other, and then there is no answer rather than a guess.
export function fiscalYearsFromInterims(facts, candidates) {
  const starts = new Set();
  let unit = null;
  for (const [ns, tag] of candidates) {
    const units = facts?.[ns]?.[tag]?.units || {};
    const chosen = units.USD ? 'USD' : Object.keys(units)[0];
    if (!chosen) continue;
    unit ??= chosen;
    if (chosen !== unit) continue;
    const byFiling = new Map();
    for (const p of units[chosen] || []) {
      if (!/^10-Q(\/A)?$/.test(p.form || '') || !p.accn || !/^\d{4}-\d{2}-\d{2}$/.test(p.start || '')
        || !/^\d{4}-\d{2}-\d{2}$/.test(p.end || '') || !Number.isFinite(p.val)) continue;
      if (!byFiling.has(p.accn)) byFiling.set(p.accn, []);
      byFiling.get(p.accn).push(p);
    }
    for (const points of byFiling.values()) {
      const periodEnd = points.reduce((max, p) => (p.end > max ? p.end : max), '');
      // The longest span ending on the filing's period end is its year to date; the longest ending
      // about a year earlier is the comparative year to date.
      for (const end of [periodEnd, points.map((p) => p.end).find((e) => Math.abs(days(e, periodEnd) - 365) <= 10)]) {
        if (!end) continue;
        const ytd = points.filter((p) => p.end === end).sort((a, b) => days(b.start, b.end) - days(a.start, a.end))[0];
        if (ytd && days(ytd.start, ytd.end) >= 70 && days(ytd.start, ytd.end) <= 290) starts.add(ytd.start);
      }
    }
  }
  const ordered = [...starts].sort();
  for (let i = 1; i < ordered.length; i++) {
    if (Math.abs(days(ordered[i - 1], ordered[i]) - 365) > 10) return null;
  }
  if (!ordered.length) return null;
  const yearAfter = (start) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return new Date(d.getTime() - DAY).toISOString().slice(0, 10);
  };
  return { unit, windows: ordered.map((start) => ({ start, end: yearAfter(start) })) };
}
